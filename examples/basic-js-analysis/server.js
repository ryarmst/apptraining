const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const port = process.env.PORT || 8080;

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// Helper function to process input (used by both GET and POST)
function processInput(transformedData) {
    const decoded = Buffer.from(transformedData, 'base64').toString('utf-8');
    const reversed = decoded.split('').reverse().join('');
    const unshifted = reversed.split('').map(char => 
        String.fromCharCode(char.charCodeAt(0) - 3)
    ).join('');
    
    // Intentionally vulnerable - directly interpolating user input into HTML
    return `<div class="message">Processed result: <span class="highlight">${unshifted}</span></div>`;
}

// POST endpoint to process the transformed input
app.post('/api/process', (req, res) => {
    const { transformedData } = req.body;
    
    try {
        const result = processInput(transformedData);
        res.json({ success: true, result, isHtml: true });
    } catch (error) {
        res.status(400).json({ success: false, error: 'Invalid input' });
    }
});

// GET endpoint for "legacy" support
app.get('/api/process', (req, res) => {
    const { data } = req.query;
    
    if (!data) {
        return res.status(400).json({ success: false, error: 'Missing data parameter' });
    }
    
    try {
        const result = processInput(data);
        res.json({ success: true, result, isHtml: true });
    } catch (error) {
        res.status(400).json({ success: false, error: 'Invalid input' });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Add a small delay before starting the server to ensure everything is ready
setTimeout(() => {
    app.listen(port, '0.0.0.0', () => {
        console.log(`Server running at http://0.0.0.0:${port}`);
    });
}, 2000); // 2 second delay 