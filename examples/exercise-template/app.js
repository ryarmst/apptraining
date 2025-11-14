const express = require('express');
const app = express();
const port = process.env.APP_PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// Sample endpoint
app.get('/api/check', (req, res) => {
    res.json({ status: 'ok' });
});

app.listen(port, () => {
    console.log(`Exercise app listening at http://localhost:${port}`);
}); 