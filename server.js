const WebSocket = require('ws');
const http = require('http');
const protobuf = require('protobufjs');
const uuid = require('uuid');
const fs = require('fs');
const path = require('path');
const express = require('express');
const app = express();
const Long = require('long');

// Create HTTP server with Express
const server = http.createServer(app);
const port = process.env.PORT || 4010;
const host = process.env.HOST || 'localhost';

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store active sessions and parties
const sessions = new Map(); // sessionId -> WebSocket
const parties = new Map();  // partyId -> Set of memberIds
const members = new Map();  // memberId -> { sessionId, partyId }

// Debug logging for message types
const messageStats = new Map(); // message type -> count

// Load Protocol Buffer definitions
let Party;
let root;

// Check if party.proto exists, if not create it
const protoPath = path.join(__dirname, 'party.proto');
if (fs.existsSync(protoPath)) {
    // Delete the existing file to ensure we use the updated definition
    fs.unlinkSync(protoPath);
    console.log('Deleted existing party.proto file');
}

console.log('Creating party.proto file...');
// The corrected Protocol Buffer definition
const protoContent = `
syntax = "proto3";

package Party;

message C2S {
  oneof msg {
    Join join = 1;
    Part part = 2;
    Data data = 3;
  }
}

message S2C {
  oneof msg {
    UserJoin join = 1;
    UserPart part = 2;
    PartyData data = 3;
  }
}

message Join {
  int64 partyId = 1;
  int64 memberId = 2;
}

message UserJoin {
  int64 partyId = 1;
  int64 memberId = 2;
}

message Part {
}

message UserPart {
  int64 partyId = 1;
  int64 memberId = 2;
}

message Data {
  bytes data = 1;
  string type = 2;
}

message PartyData {
  int64 partyId = 1;
  int64 memberId = 2;
  bytes data = 3;
  string type = 4;
}
`;

fs.writeFileSync(protoPath, protoContent);
console.log('party.proto file created');

// Load Protocol Buffer definitions
protobuf.load(protoPath)
    .then(loadedRoot => {
        root = loadedRoot;
        // Configure protobuf to use Long.js for int64 fields
        root.lookupType("Party.Join").ctor.prototype.memberId = {
            constructor: Long
        };
        root.lookupType("Party.UserJoin").ctor.prototype.memberId = {
            constructor: Long
        };
        root.lookupType("Party.UserPart").ctor.prototype.memberId = {
            constructor: Long
        };
        root.lookupType("Party.PartyData").ctor.prototype.memberId = {
            constructor: Long
        };

        Party = {
            C2S: root.lookupType("Party.C2S"),
            S2C: root.lookupType("Party.S2C"),
            Join: root.lookupType("Party.Join"),
            UserJoin: root.lookupType("Party.UserJoin"),
            Part: root.lookupType("Party.Part"),
            UserPart: root.lookupType("Party.UserPart"),
            Data: root.lookupType("Party.Data"),
            PartyData: root.lookupType("Party.PartyData")
        };
        console.log("Protocol buffers loaded successfully with Long.js support");
    })
    .catch(err => {
        console.error("Failed to load protocol buffers:", err);
        process.exit(1);
    });


// Add debug endpoints
app.get('/debug/parties', (req, res) => {
    const result = {
        parties: {},
        members: {},
        sessions: Array.from(sessions.keys())
    };

    for (const [partyId, memberSet] of parties.entries()) {
        result.parties[partyId] = Array.from(memberSet);
    }

    for (const [memberId, info] of members.entries()) {
        result.members[memberId] = info;
    }

    res.json(result);
});

app.get('/debug/messages', (req, res) => {
    const result = {};
    for (const [type, count] of messageStats.entries()) {
        result[type] = count;
    }
    res.json(result);
});

// Add a root endpoint for basic info
app.get('/', (req, res) => {
    res.send(`
        <h1>RuneLite Party Server</h1>
        <p>Server is running.</p>
        <p>Active sessions: ${sessions.size}</p>
        <p>Active parties: ${parties.size}</p>
        <p>Active members: ${members.size}</p>
        <p><a href="/debug/parties">View parties</a></p>
        <p><a href="/debug/messages">View message stats</a></p>
    `);
});

// Helper function to send a message to a specific member
function sendMessageToMember(memberId, message, description) {
    const memberInfo = members.get(memberId);
    if (!memberInfo) {
        console.log(`Cannot send ${description} to unknown member ${memberId}`);
        return false;
    }

    const ws = sessions.get(memberInfo.sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.log(`Cannot send ${description} to member ${memberId}, WebSocket not open`);
        return false;
    }

    try {
        const s2cBuffer = Party.S2C.encode(Party.S2C.create(message)).finish();
        ws.send(s2cBuffer);
        console.log(`Sent ${description} to member ${memberId}`);
        return true;
    } catch (error) {
        console.error(`Error sending ${description} to member ${memberId}:`, error);
        return false;
    }
}

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
    // Parse session ID from URL query parameters
    const url = new URL(req.url, `http://${host}`);
    const sessionId = url.searchParams.get('sessionId') || uuid.v4();

    console.log(`New connection with session ID: ${sessionId}`);
    sessions.set(sessionId, ws);

    // Handle messages from clients
    ws.on('message', (message) => {
        if (!Party || !Party.C2S) {
            console.log('Protocol buffers not loaded yet, cannot process message');
            return;
        }

        try {
            // Parse the protobuf message
            const c2sMessage = Party.C2S.decode(new Uint8Array(message));

            // Handle based on message type
            const msgCase = c2sMessage.msg;

            if (msgCase === 'join') {
                handleJoin(sessionId, ws, c2sMessage.join);
            } else if (msgCase === 'part') {
                handlePart(sessionId, ws);
            } else if (msgCase === 'data') {
                handleData(sessionId, ws, {
                    type: c2sMessage.data.type,
                    data: c2sMessage.data.data
                });
            } else {
                console.log(`Unknown message type: ${msgCase}`);
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    // Handle disconnections
    ws.on('close', () => {
        console.log(`WebSocket closed for ${sessionId}`);
        handleDisconnect(sessionId);
    });

    // Handle errors
    ws.on('error', (error) => {
        console.error(`WebSocket error for ${sessionId}:`, error);
    });
});

// Handle party join requests
function handleJoin(sessionId, ws, joinMessage) {
    // Store the original Long objects or their string representation
    const partyId = joinMessage.partyId.toString();
    const memberId = joinMessage.memberId.toString();

    console.log(`Member ${memberId} joining party ${partyId}`);
    console.log(`Original memberId type: ${typeof joinMessage.memberId}, value: ${joinMessage.memberId}`);

    // Store member information with the original Long object
    members.set(memberId, {
        sessionId,
        partyId,
        // Store the original Long object for later use
        originalMemberId: joinMessage.memberId
    });

    // Create party if it doesn't exist
    if (!parties.has(partyId)) {
        parties.set(partyId, new Set());
        console.log(`Created new party: ${partyId}`);
    }

    // Add member to party
    parties.get(partyId).add(memberId);
    console.log(`Added member ${memberId} to party ${partyId}`);

    // Send UserJoin message to all party members using the original Long object
    const userJoinMessage = {
        join: {
            partyId: joinMessage.partyId,  // Use the original Long object
            memberId: joinMessage.memberId // Use the original Long object
        }
    };

    console.log(`Broadcasting join message for member ${memberId} to party ${partyId}`);
    broadcastToParty(partyId, memberId, userJoinMessage);

    // Send information about existing members to the new member
    const party = parties.get(partyId);
    if (party) {
        console.log(`Sending information about existing members to new member ${memberId}`);

        for (const existingMemberId of party) {
            // Skip the new member itself
            if (existingMemberId === memberId) {
                continue;
            }

            // Get the original Long object for the existing member
            const existingMemberInfo = members.get(existingMemberId);
            if (!existingMemberInfo) {
                console.log(`Missing member info for ${existingMemberId}, skipping`);
                continue;
            }

            // Use the original Long object if available, otherwise create a new one
            const existingMemberLongId = existingMemberInfo.originalMemberId ||
                Long.fromString(existingMemberId);

            // Send UserJoin message for each existing member
            const existingMemberJoinMessage = {
                join: {
                    partyId: joinMessage.partyId,
                    memberId: existingMemberLongId
                }
            };

            console.log(`Sending join message for existing member ${existingMemberId} to new member ${memberId}`);
            sendMessageToMember(memberId, existingMemberJoinMessage,
                `join message for existing member ${existingMemberId}`);
        }
    }

    // Log current party state
    console.log(`Party ${partyId} now has ${parties.get(partyId).size} members`);
}
// Handle party leave requests
function handlePart(sessionId) {
    // Find the member associated with this session
    let partingMemberId = null;
    let partyId = null;

    for (const [memberId, info] of members.entries()) {
        if (info.sessionId === sessionId) {
            partingMemberId = memberId;
            partyId = info.partyId;
            break;
        }
    }

    if (partingMemberId && partyId) {
        console.log(`Member ${partingMemberId} leaving party ${partyId}`);
        removeMemberFromParty(partingMemberId, partyId);
    }
}

function handleData(sessionId, ws, dataMessage) {
    // Find the member and party for this session
    let sendingMemberId = null;
    let partyId = null;
    let originalMemberId = null;

    for (const [memberId, info] of members.entries()) {
        if (info.sessionId === sessionId) {
            sendingMemberId = memberId;
            partyId = info.partyId;
            originalMemberId = info.originalMemberId;
            break;
        }
    }

    if (!sendingMemberId || !partyId) {
        console.log('Data message from unknown member');
        return;
    }

    // Log the raw data for debugging
    console.log(`Raw data message from member ${sendingMemberId}:`);
    console.log(hexDump(dataMessage.data));
    console.log(`Raw type: "${dataMessage.type}"`);

    // Create a PartyData message
    const partyDataMessage = {
        data: {
            partyId: Long.fromString(partyId),
            memberId: originalMemberId || Long.fromString(sendingMemberId),
            data: dataMessage.data,
            type: dataMessage.type
        }
    };

    // Log the constructed message
    console.log(`Constructed PartyData message:`);
    console.log(`- partyId: ${partyDataMessage.data.partyId}`);
    console.log(`- memberId: ${partyDataMessage.data.memberId}`);
    console.log(`- data length: ${partyDataMessage.data.data.length} bytes`);
    console.log(`- type: "${partyDataMessage.data.type}"`);

    // Broadcast to all party members
    broadcastToParty(partyId, sendingMemberId, partyDataMessage);
}

function hexDump(buffer, maxLength = 100) {
    const bytes = Array.from(buffer).slice(0, maxLength);
    const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = bytes.map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
    return `Hex: ${hex}${buffer.length > maxLength ? '...' : ''}\nASCII: ${ascii}${buffer.length > maxLength ? '...' : ''}`;
}
// Handle client disconnections
function handleDisconnect(sessionId) {
    // Find the member associated with this session
    let disconnectedMemberId = null;
    let partyId = null;

    for (const [memberId, info] of members.entries()) {
        if (info.sessionId === sessionId) {
            disconnectedMemberId = memberId;
            partyId = info.partyId;
            break;
        }
    }

    if (disconnectedMemberId && partyId) {
        removeMemberFromParty(disconnectedMemberId, partyId);
    }

    // Remove session
    sessions.delete(sessionId);
}

function removeMemberFromParty(memberId, partyId) {
    console.log(`Removing member ${memberId} from party ${partyId}`);

    // Get the original Long object if available
    const memberInfo = members.get(memberId);
    const originalMemberId = memberInfo ? memberInfo.originalMemberId : null;

    // Remove member from party
    const party = parties.get(partyId);
    if (party) {
        party.delete(memberId);
        console.log(`Removed member ${memberId} from party ${partyId}`);

        // If party is empty, remove it
        if (party.size === 0) {
            parties.delete(partyId);
            console.log(`Party ${partyId} is now empty, removing it`);
        }
    }

    // Remove member record
    members.delete(memberId);

    // Send UserPart message to all party members using the original Long or creating a new one
    const userPartMessage = {
        part: {
            memberId: originalMemberId || Long.fromString(memberId)
        }
    };

    broadcastToParty(partyId, null, userPartMessage);
}
// Broadcast a message to all members of a party
function broadcastToParty(partyId, senderMemberId, message) {
    const partyIdStr = partyId.toString();

    // Check if the party exists
    if (!parties.has(partyIdStr)) {
        console.log(`Cannot broadcast to non-existent party: ${partyIdStr}`);
        return;
    }

    const party = parties.get(partyIdStr);

    try {
        // Log the message structure for debugging
        if (message.data) {
            console.log(`Broadcasting ${message.data.type} message to party ${partyIdStr}`);
            console.log(`Message structure: memberId=${message.data.memberId}, type=${message.data.type}, dataSize=${message.data.data.length}`);

            // Debug the protocol buffer message
            console.log(`Debugging Protocol Buffer message:`);
            console.log(`- Type: DATA`);
            console.log(`- Member ID: ${message.data.memberId}`);
            console.log(`- Message Type: "${message.data.type}"`);
            console.log(`- Data Size: ${message.data.data.length} bytes`);

            // Log the data content for debugging
            if (message.data.data.length > 0) {
                const dataBytes = Array.from(message.data.data).join(',');
                console.log(`- Data Content: ${dataBytes}`);
            }
        }

        // Encode the message to a binary buffer
        const s2cBuffer = Party.S2C.encode(Party.S2C.create(message)).finish();
        console.log(`Encoded message to buffer, size: ${s2cBuffer.length} bytes`);

        // Log the first few bytes for debugging
        if (s2cBuffer.length > 0) {
            const firstBytes = Array.from(s2cBuffer.slice(0, Math.min(s2cBuffer.length, 20)))
                .map(b => b.toString(16).padStart(2, '0'))
                .join(' ');
            console.log(`First bytes: ${firstBytes}`);
        }

        let sentCount = 0;
        for (const memberId of party) {
            const memberInfo = members.get(memberId);
            if (memberInfo) {
                const ws = sessions.get(memberInfo.sessionId);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(s2cBuffer);
                    sentCount++;
                    console.log(`Sent ${message.data ? message.data.type : 'message'} to member ${memberId}`);
                }
            }
        }
        console.log(`Broadcast message to ${sentCount}/${party.size} members of party ${partyIdStr}`);
    } catch (error) {
        console.error('Error broadcasting message:', error);
    }
}
// Start the server
server.listen(port, host, () => {
    console.log(`WebSocket server listening on http://${host}:${port}`);
});
