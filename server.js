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
const sessions = new Map(); // sessionId - WebSocket
const parties = new Map();  // partyId - Set of memberIds
const members = new Map();  // memberId - { sessionId, partyId }

// Debug logging for message types
const messageStats = new Map(); // message type - count

// Load Protocol Buffer definitions
let root;
let Join, Part, UserJoin, UserPart, Data, UserSync;

// Check if party.proto exists, if not create it
const protoPath = path.join(__dirname, 'party.proto');
if (fs.existsSync(protoPath)) {
  // Delete the existing file to ensure we use the updated definition
  fs.unlinkSync(protoPath);
  console.log('Deleted existing party.proto file');
}

console.log('Creating party.proto file...');

// Updated Protocol Buffer definition to match RuneLite's expectations
const protoContent = `
syntax = "proto3";

package net.runelite.client.party.messages;

message Join {
  int64 partyId = 1;
  int64 memberId = 2;
}

message Part {
}

message UserJoin {
  int64 partyId = 1;
  int64 memberId = 2;
}

message UserPart {
  int64 memberId = 1;
}

message UserSync {
}

message Data {
  bytes data = 1;
  string type = 2;
}
`;

fs.writeFileSync(protoPath, protoContent);
console.log('party.proto file created');

// Load Protocol Buffer definitions
protobuf.load(protoPath)
  .then(loadedRoot => {
    root = loadedRoot;
    
    // Get message types
    Join = root.lookupType("net.runelite.client.party.messages.Join");
    Part = root.lookupType("net.runelite.client.party.messages.Part");
    UserJoin = root.lookupType("net.runelite.client.party.messages.UserJoin");
    UserPart = root.lookupType("net.runelite.client.party.messages.UserPart");
    Data = root.lookupType("net.runelite.client.party.messages.Data");
    UserSync = root.lookupType("net.runelite.client.party.messages.UserSync");
    
    console.log("Protocol buffers loaded successfully");
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
<ul>
  <li>Active sessions: ${sessions.size}</li>
  <li>Active parties: ${parties.size}</li>
  <li>Active members: ${members.size}</li>
</ul>
<p><a href="/debug/parties">/debug/parties</a> <a href="/debug/messages">/debug/messages</a></p>
  `);
});

// Helper function to send a message to a specific member
function sendMessageToMember(memberId, messageType, messageData, description) {
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
    // Create and encode the message
    const message = messageType.create(messageData);
    const buffer = messageType.encode(message).finish();
    
    // Send the message
    ws.send(buffer);
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
    if (!root) {
      console.log('Protocol buffers not loaded yet, cannot process message');
      return;
    }
    
    try {
      // Try to decode the message as each possible type
      let decoded = null;
      let messageType = null;
      
      // Try Join
      try {
        decoded = Join.decode(new Uint8Array(message));
        messageType = 'Join';
      } catch (e) {}
      
      // Try Part
      if (!decoded) {
        try {
          decoded = Part.decode(new Uint8Array(message));
          messageType = 'Part';
        } catch (e) {}
      }
      
      // Try Data
      if (!decoded) {
        try {
          decoded = Data.decode(new Uint8Array(message));
          messageType = 'Data';
        } catch (e) {}
      }
      
      // Try UserSync
      if (!decoded) {
        try {
          decoded = UserSync.decode(new Uint8Array(message));
          messageType = 'UserSync';
        } catch (e) {}
      }
      
      // If we couldn't decode the message, log an error
      if (!decoded) {
        console.log('Could not decode message as any known type');
        return;
      }
      
      // Track message type for stats
      messageStats.set(messageType, (messageStats.get(messageType) || 0) + 1);
      
      // Handle based on message type
      if (messageType === 'Join') {
        handleJoin(sessionId, ws, decoded);
      } else if (messageType === 'Part') {
        handlePart(sessionId, ws);
      } else if (messageType === 'Data') {
        handleData(sessionId, ws, decoded);
      } else if (messageType === 'UserSync') {
        handleUserSync(sessionId, ws);
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
  const partyId = joinMessage.partyId.toString();
  const memberId = joinMessage.memberId.toString();
  
  console.log(`Member ${memberId} joining party ${partyId}`);
  
  // Store member information
  members.set(memberId, {
    sessionId,
    partyId,
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
  
  // Send UserJoin message to all party members
  const userJoinMessage = {
    partyId: joinMessage.partyId,
    memberId: joinMessage.memberId
  };
  
  broadcastToParty(partyId, memberId, UserJoin, userJoinMessage, 'UserJoin');
  
  // Send information about existing members to the new member
  const party = parties.get(partyId);
  if (party) {
    console.log(`Sending information about existing members to new member ${memberId}`);
    
    for (const existingMemberId of party) {
      // Skip the new member itself
      if (existingMemberId === memberId) {
        continue;
      }
      
      const existingMemberInfo = members.get(existingMemberId);
      if (!existingMemberInfo) {
        console.log(`Missing member info for ${existingMemberId}, skipping`);
        continue;
      }
      
      const existingMemberLongId = existingMemberInfo.originalMemberId || 
                                   Long.fromString(existingMemberId);
      
      const existingMemberJoinMessage = {
        partyId: joinMessage.partyId,
        memberId: existingMemberLongId
      };
      
      sendMessageToMember(
        memberId,
        UserJoin,
        existingMemberJoinMessage,
        `join message for existing member ${existingMemberId}`
      );
    }
  }
  
  console.log(`Party ${partyId} now has ${parties.get(partyId).size} members`);
}

// Handle UserSync messages
function handleUserSync(sessionId, ws) {
  // Find the member associated with this session
  let memberId = null;
  let partyId = null;
  
  for (const [id, info] of members.entries()) {
    if (info.sessionId === sessionId) {
      memberId = id;
      partyId = info.partyId;
      break;
    }
  }
  
  if (!memberId || !partyId) {
    console.log('UserSync from unknown member');
    return;
  }
  
  console.log(`Received UserSync from member ${memberId} in party ${partyId}`);
  
  // In a real implementation, you might want to handle synchronization of member state here
  // For now, we'll just log it
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
  
  console.log(`Received data message of type ${dataMessage.type} from member ${sendingMemberId}`);
  
  // Broadcast to all party members
  broadcastToParty(partyId, sendingMemberId, Data, dataMessage, 'Data');
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
  
  // Send UserPart message to all party members
  const userPartMessage = {
    memberId: originalMemberId || Long.fromString(memberId)
  };
  
  broadcastToParty(partyId, null, UserPart, userPartMessage, 'UserPart');
}

// Broadcast a message to all members of a party
function broadcastToParty(partyId, senderMemberId, messageType, messageData, messageTypeName) {
  const partyIdStr = partyId.toString();
  
  // Check if the party exists
  if (!parties.has(partyIdStr)) {
    console.log(`Cannot broadcast to non-existent party: ${partyIdStr}`);
    return;
  }
  
  const party = parties.get(partyIdStr);
  
  try {
    console.log(`Broadcasting ${messageTypeName} message to party ${partyIdStr}`);
    
    // Create and encode the message
    const message = messageType.create(messageData);
    const buffer = messageType.encode(message).finish();
    
    let sentCount = 0;
    
    for (const memberId of party) {
      // Skip sending to the sender for data messages
      if (memberId === senderMemberId && messageTypeName === 'Data') {
        continue;
      }
      
      const memberInfo = members.get(memberId);
      if (memberInfo) {
        const ws = sessions.get(memberInfo.sessionId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(buffer);
          sentCount++;
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

