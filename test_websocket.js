const WebSocket = require('ws');

// Create WebSocket connection
const ws = new WebSocket('ws://localhost:3000');

// Connection opened
ws.on('open', function open() {
    console.log('Connected to WebSocket server');
    
    // Send a test message
    const testMessage = {
        kind: 'TestMessage',
        data: {
            text: 'Hello from test client',
            timestamp: new Date().toISOString()
        }
    };
    
    ws.send(JSON.stringify(testMessage));
});

// Listen for messages
ws.on('message', function incoming(data) {
    console.log('Received:', data.toString());
});

// Handle errors
ws.on('error', function error(err) {
    console.error('WebSocket error:', err);
});

// Handle connection close
ws.on('close', function close() {
    console.log('Connection closed');
}); 