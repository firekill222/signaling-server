const WebSocket = require('ws');
const http = require('http');
const protobuf = require('protobufjs');
const uuid = require('uuid');
const fs = require('fs');
const path = require('path');
const express = require('express');
const app = express();

// Create HTTP server with Express
const server = http.createServer(app);
const port = process.env.PORT || 8080;
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
        console.log("Protocol buffers loaded successfully");

        // Log the available types for debugging
        console.log("Available types:");
        for (const namespace of root.nestedArray) {
            console.log(`Namespace: ${namespace.name}`);
            for (const type of namespace.nestedArray) {
                console.log(`  - ${type.name}`);
            }
        }
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

// Add a message inspection endpoint
app.get('/debug/inspect/:type', (req, res) => {
    const messageType = req.params.type;
    const result = {
        type: messageType,
        count: messageStats.get(messageType) || 0,
        examples: []
    };

    // Add some example data if available
    // (You would need to store this separately)

    res.json(result);
});

// Add this function to test sending a properly formatted message
function sendTestMessage(partyId, messageType) {
    const party = parties.get(parseInt(partyId));
    if (!party) {
        console.log(`Cannot send test message to non-existent party: ${partyId}`);
        return;
    }

    // Create a test message with proper JSON structure
    const testData = {
        m: [{ t: "R", v: 100 }]
    };

    const testMessage = {
        data: {
            partyId: parseInt(partyId),
            memberId: 0, // Server message
            type: messageType,
            data: Buffer.from(JSON.stringify(testData))
        }
    };

    console.log(`Sending test ${messageType} message to party ${partyId}`);
    broadcastToParty(partyId, 0, testMessage);
}

// Add a test endpoint
app.get('/debug/test/:partyId/:type', (req, res) => {
    const partyId = parseInt(req.params.partyId);
    const messageType = req.params.type;

    sendTestMessage(partyId, messageType);

    res.json({ success: true, message: `Sent test ${messageType} message to party ${partyId}` });
});

// Add this function to check if the protocol buffers are loaded
function checkProtobufLoaded() {
    if (!Party || !Party.C2S || !Party.S2C) {
        console.error("Protocol buffers not fully loaded");
        console.log("Party object:", Party);
        return false;
    }
    return true;
}

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
    // Parse session ID from URL query parameters
    const url = new URL(req.url, `http://${host}`);
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId) {
        console.log('Connection rejected: No session ID provided');
        ws.close(1000, 'No session ID provided');
        return;
    }

    console.log(`New connection with session ID: ${sessionId}`);
    sessions.set(sessionId, ws);

    // Send a welcome message to confirm connection
    try {
        if (checkProtobufLoaded()) {
            const welcomeMessage = {
                data: {
                    memberId: 0,
                    data: Buffer.from(JSON.stringify({ message: "Welcome to the server" })),
                    type: "ServerWelcome"
                }
            };

            const s2cBuffer = Party.S2C.encode(Party.S2C.create(welcomeMessage)).finish();
            ws.send(s2cBuffer);
            console.log(`Sent welcome message to ${sessionId}`);
        } else {
            console.log('Protocol buffers not loaded yet, cannot send welcome message');
        }
    } catch (error) {
        console.error('Error sending welcome message:', error);
    }

    // Handle messages from clients
    ws.on('message', (message) => {
        if (!checkProtobufLoaded()) {
            console.log('Protocol buffers not loaded yet, cannot process message');
            return;
        }

        try {
            // Log the raw message for debugging
            console.log(`Received raw message from ${sessionId}, length: ${message.length} bytes`);

            // Parse the protobuf message
            const c2sMessage = Party.C2S.decode(new Uint8Array(message));

            // Log the message type
            const msgCase = c2sMessage.msg;
            console.log(`Received message case: ${msgCase}`);

            if (msgCase === 'join') {
                console.log(`Join message details: partyId=${c2sMessage.join.partyId}, memberId=${c2sMessage.join.memberId}`);
                handleJoin(sessionId, ws, c2sMessage.join);
            } else if (msgCase === 'part') {
                console.log('Part message received');
                handlePart(sessionId, ws);
            } else if (msgCase === 'data') {
                // Extract the type correctly from the Data message
                let dataType = c2sMessage.data.type;

                // If the type is a JSON string, extract the actual type
                if (dataType.startsWith('{') && dataType.includes('"type"')) {
                    try {
                        const typeObj = JSON.parse(dataType);
                        if (typeObj && typeObj.type) {
                            dataType = typeObj.type;
                            console.log(`Extracted type from JSON: ${dataType}`);
                        }
                    } catch (e) {
                        console.log(`Failed to parse type as JSON: ${e.message}`);
                    }
                }

                console.log(`Data message details: type=${dataType}, data length=${c2sMessage.data.data.length}`);

                // Handle the data message
                handleData(sessionId, ws, {
                    type: dataType,
                    data: c2sMessage.data.data
                });
            } else {
                console.log(`Unknown message type: ${msgCase}`);
            }
        } catch (error) {
            console.error('Error processing message:', error);
            console.error('Message was:', message);
        }
    });


    // Handle disconnections
    ws.on('close', (code, reason) => {
        console.log(`WebSocket closed for ${sessionId}: ${code} - ${reason || 'No reason provided'}`);
        handleDisconnect(sessionId);
    });

    // Handle errors
    ws.on('error', (error) => {
        console.error(`WebSocket error for ${sessionId}:`, error);
    });
});

// Handle party join requests
function handleJoin(sessionId, ws, joinMessage) {
    // Convert partyId and memberId to strings for consistent comparison
    const partyId = joinMessage.partyId.toString();
    const memberId = joinMessage.memberId.toString();

    console.log(`Member ${memberId} joining party ${partyId}`);

    // Store member information
    members.set(memberId, { sessionId, partyId });

    // Create party if it doesn't exist
    if (!parties.has(partyId)) {
        parties.set(partyId, new Set());
        console.log(`Created new party: ${partyId}`);
    }

    // Add member to party
    parties.get(partyId).add(memberId);
    console.log(`Added member ${memberId} to party ${partyId}`);

    // Send UserJoin message to all party members
    const userJoinMessage = {
        join: {
            partyId: joinMessage.partyId,
            memberId: joinMessage.memberId
        }
    };

    console.log(`Broadcasting join message for member ${memberId} to party ${partyId}`);
    broadcastToParty(partyId, memberId, userJoinMessage);

    // COMPREHENSIVE FIX: Send complete information about all existing members to the new member
    const party = parties.get(partyId);
    if (party) {
        console.log(`Sending complete member information to new member ${memberId}`);

        // For each existing member, send all necessary information to the new member
        for (const existingMemberId of party) {
            // Skip the new member itself
            if (existingMemberId === memberId) {
                continue;
            }

            // 1. Send UserJoin message for this existing member
            const existingMemberJoinMessage = {
                join: {
                    partyId: joinMessage.partyId,
                    memberId: parseInt(existingMemberId)
                }
            };

            // Send this join message to the new member
            sendMessageToMember(memberId, existingMemberJoinMessage,
                `join message for existing member ${existingMemberId}`);

            // 2. Send a StatusUpdate for this existing member
            // Create a default status if we don't have real data
            const statusData = {
                n: `Member ${existingMemberId}`,  // name (character name)
                hc: 100,                  // health current
                hm: 100,                  // health max
                pc: 100,                  // prayer current
                pm: 100,                  // prayer max
                r: 100,                   // run energy
                s: 100,                   // special energy
                v: true,                  // vengeance active
                c: "#FF0000"              // member color (hex color code)
            };

            const statusUpdateMessage = {
                data: {
                    partyId: parseInt(partyId),
                    memberId: parseInt(existingMemberId),
                    type: 'StatusUpdate',
                    data: Buffer.from(JSON.stringify(statusData))
                }
            };

            // Send this status update to the new member
            sendMessageToMember(memberId, statusUpdateMessage,
                `StatusUpdate for existing member ${existingMemberId}`);

            // 3. Send a LocationUpdate for this existing member if needed
            // This is optional but helps with complete synchronization
            const locationData = {
                x: 3200 + Math.floor(Math.random() * 100),  // Random x coordinate
                y: 3200 + Math.floor(Math.random() * 100),  // Random y coordinate
                plane: 0
            };

            const locationUpdateMessage = {
                data: {
                    partyId: parseInt(partyId),
                    memberId: parseInt(existingMemberId),
                    type: 'LocationUpdate',
                    data: Buffer.from(JSON.stringify(locationData))
                }
            };

            // Send this location update to the new member
            sendMessageToMember(memberId, locationUpdateMessage,
                `LocationUpdate for existing member ${existingMemberId}`);
        }
    }

    // Log current party state
    logPartyState(partyId);
}

// Handle party leave requests
function handlePart(sessionId, ws) {
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
    } else {
        console.log(`Part request from unknown member, sessionId: ${sessionId}`);
    }
}

// Handle data messages
function handleData(sessionId, ws, dataMessage) {
    // Find the member and party for this session
    let sendingMemberId = null;
    let partyId = null;

    for (const [memberId, info] of members.entries()) {
        if (info.sessionId === sessionId) {
            sendingMemberId = memberId;
            partyId = info.partyId;
            break;
        }
    }

    if (!sendingMemberId || !partyId) {
        console.log('Data message from unknown member');
        return;
    }

    // Extract the message type
    let messageType = dataMessage.type;
    console.log(`Raw message type: ${messageType}`);

    // Try to parse and log the data content for debugging
    let dataContent;
    let jsonData = null;
    try {
        dataContent = dataMessage.data.toString('utf8');
        console.log(`Raw data content: ${dataContent}`);

        // Try to parse the data content as JSON
        try {
            jsonData = JSON.parse(dataContent);

            // Special handling for different message types
            switch (messageType) {
                case 'DestinationTileMessage':
                    console.log(`Processing DestinationTileMessage from ${sendingMemberId}`);
                    if (jsonData.destination) {
                        console.log(`Destination: x=${jsonData.destination.x}, y=${jsonData.destination.y}, plane=${jsonData.destination.plane}`);
                    } else {
                        console.log(`DestinationTileMessage with no destination (clear message)`);
                    }
                    break;

                case 'PartyBatchedChange':
                    console.log(`Processing PartyBatchedChange from ${sendingMemberId}`);
                    if (jsonData.m && jsonData.m.length > 0) {
                        console.log(`Batch changes: ${jsonData.m.length} misc changes`);
                    }
                    if (jsonData.s && jsonData.s.length > 0) {
                        console.log(`Stat changes: ${jsonData.s.length} stat changes`);
                    }
                    break;

                case 'LocationUpdate':
                    console.log(`Processing LocationUpdate from ${sendingMemberId}`);
                    if (jsonData.c) {
                        console.log(`Location code: ${jsonData.c}`);
                    }
                    break;

                case 'StatusUpdate':
                    console.log(`Processing StatusUpdate from ${sendingMemberId}`);
                    console.log(`Character: ${jsonData.n}, Health: ${jsonData.hc}/${jsonData.hm}, Prayer: ${jsonData.pc}/${jsonData.pm}`);
                    break;

                case 'StatUpdate':
                    console.log(`Processing StatUpdate from ${sendingMemberId}`);
                    console.log(`Character: ${jsonData.n}, Personal Points: ${jsonData.pp}`);
                    break;

                case 'DiscordUserInfo':
                    console.log(`Processing DiscordUserInfo from ${sendingMemberId}`);
                    console.log(`Discord User: ${jsonData.username}#${jsonData.discriminator}, ID: ${jsonData.userId}`);
                    break;

                default:
                    console.log(`Processing generic message type: ${messageType}`);
                    console.log(`Data parsed as JSON: ${JSON.stringify(jsonData).substring(0, 200)}`);
            }
        } catch (e) {
            console.log(`Data content is not valid JSON: ${e.message}`);
        }
    } catch (e) {
        console.log('Could not convert data to string');
    }

    // Track message stats
    messageStats.set(messageType, (messageStats.get(messageType) || 0) + 1);

    // Create party data message with the exact structure expected by clients
    const partyDataMessage = {
        data: {
            partyId: parseInt(partyId),
            memberId: parseInt(sendingMemberId),
            type: messageType,
            data: dataMessage.data  // Keep the original binary data
        }
    };

    // Log what we're broadcasting
    console.log(`Broadcasting ${messageType} from ${sendingMemberId} to party ${partyId}`);

    // Broadcast to all party members (including sender)
    broadcastToParty(partyId, sendingMemberId, partyDataMessage);
}


// Handle client disconnections
function handleDisconnect(sessionId) {
    console.log(`Session ${sessionId} disconnected`);

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
        console.log(`Disconnected member ${disconnectedMemberId} from party ${partyId}`);
        removeMemberFromParty(disconnectedMemberId, partyId);
    } else {
        console.log(`Disconnection from unknown member, sessionId: ${sessionId}`);
    }

    // Remove session
    sessions.delete(sessionId);
    console.log(`Removed session: ${sessionId}`);
}

// Remove a member from a party and notify other members
function removeMemberFromParty(memberId, partyId) {
    console.log(`Removing member ${memberId} from party ${partyId}`);

    // Remove member from party
    const party = parties.get(partyId);
    if (party) {
        party.delete(memberId);
        console.log(`Deleted member ${memberId} from party ${partyId}`);

        // If party is empty, remove it
        if (party.size === 0) {
            parties.delete(partyId);
            console.log(`Party ${partyId} is now empty, removing it`);
        }
    }

    // Remove member record
    members.delete(memberId);
    console.log(`Removed member record for ${memberId}`);

    // Send UserPart message to all party members
    const userPartMessage = {
        part: {
            memberId: memberId
        }
    };

    console.log(`Broadcasting part message for member ${memberId} to party ${partyId}`);
    broadcastToParty(partyId, null, userPartMessage);  // Pass null as senderMemberId for part messages

    // Log current party state
    logPartyState(partyId);
}

// Broadcast a message to all members of a party
function broadcastToParty(partyId, senderMemberId, message) {
    // Convert partyId to string for consistent comparison
    const partyIdStr = partyId.toString();

    // Check if the party exists
    if (!parties.has(partyIdStr)) {
        console.log(`Cannot broadcast to non-existent party: ${partyIdStr}`);
        console.log('Available parties:', Array.from(parties.keys()));
        return;
    }

    const party = parties.get(partyIdStr);

    try {
        // Log the message structure for debugging
        console.log(`Broadcasting message to party ${partyIdStr}:`);
        console.log(JSON.stringify(message, (key, value) => {
            if (key === 'data' && value && value.data && value.data.length > 20) {
                return `<Binary data of length ${value.data.length}>`;
            }
            return value;
        }, 2));

        // Encode the message to a binary buffer
        const s2cBuffer = Party.S2C.encode(Party.S2C.create(message)).finish();
        console.log(`Encoded message to buffer, size: ${s2cBuffer.length} bytes`);

        // Log the first few bytes for debugging
        if (s2cBuffer.length > 0) {
            const firstBytes = s2cBuffer.slice(0, Math.min(s2cBuffer.length, 32));
            let hexString = '';
            for (let i = 0; i < firstBytes.length; i++) {
                hexString += firstBytes[i].toString(16).padStart(2, '0').toUpperCase() + ' ';
            }
            console.log(`First bytes of encoded message: ${hexString}`);
        }

        let sentCount = 0;
        for (const memberId of party) {
            const memberInfo = members.get(memberId);
            if (memberInfo) {
                const ws = sessions.get(memberInfo.sessionId);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(s2cBuffer);
                    sentCount++;
                    console.log(`Sent message to member ${memberId}${memberId === senderMemberId ? ' (sender)' : ''}`);
                } else {
                    console.log(`Cannot send to member ${memberId}, WebSocket not open`);
                }
            } else {
                console.log(`Member info not found for ${memberId}`);
            }
        }
        console.log(`Broadcast message to ${sentCount}/${party.size} members of party ${partyIdStr}`);
    } catch (error) {
        console.error('Error broadcasting message:', error);
        console.error('Message was:', JSON.stringify(message, (key, value) => {
            if (key === 'data' && value && value.data && value.data.length > 20) {
                return `<Binary data of length ${value.data.length}>`;
            }
            return value;
        }, 2));
    }
}


// Log the current state of a party
function logPartyState(partyId) {
    const party = parties.get(partyId);
    if (!party) {
        console.log(`Party ${partyId} does not exist`);
        return;
    }

    console.log(`Party ${partyId} has ${party.size} members:`);
    for (const memberId of party) {
        const memberInfo = members.get(memberId);
        console.log(`- Member ${memberId}, sessionId: ${memberInfo ? memberInfo.sessionId : 'unknown'}`);
    }
}

// Print server status and message stats periodically
setInterval(() => {
    console.log('\n=== Server Status ===');
    console.log(`Active sessions: ${sessions.size}`);
    console.log(`Active parties: ${parties.size}`);
    console.log(`Active members: ${members.size}`);

    for (const [partyId, memberSet] of parties.entries()) {
        console.log(`Party ${partyId}: ${memberSet.size} members`);
        for (const memberId of memberSet) {
            const memberInfo = members.get(memberId);
            console.log(`  - Member ${memberId}, sessionId: ${memberInfo ? memberInfo.sessionId : 'unknown'}`);
        }
    }

    console.log('\n=== Message Stats ===');
    for (const [type, count] of messageStats.entries()) {
        console.log(`${type}: ${count}`);
    }
    console.log('=====================\n');
}, 30000); // Log every 30 seconds

// Add a debug endpoint to check party storage
app.get('/debug/storage', (req, res) => {
    const result = {
        parties: {},
        members: {},
        sessions: {}
    };

    // Get party information
    for (const [partyId, memberSet] of parties.entries()) {
        result.parties[partyId] = {
            id: partyId,
            members: Array.from(memberSet),
            type: typeof partyId
        };
    }

    // Get member information
    for (const [memberId, info] of members.entries()) {
        result.members[memberId] = {
            id: memberId,
            sessionId: info.sessionId,
            partyId: info.partyId,
            type: typeof memberId
        };
    }

    // Get session information
    for (const [sessionId, ws] of sessions.entries()) {
        result.sessions[sessionId] = {
            id: sessionId,
            readyState: ws.readyState,
            type: typeof sessionId
        };
    }

    res.json(result);
});

// Start the server
server.listen(port, host, () => {
    console.log(`WebSocket server listening on http://${host}:${port}`);
    console.log(`WebSocket URL: ws://${host}:${port}`);
});
