const express = require('express');
const app = express();
const port = 8080;

app.use(express.json());
app.use(express.static('public'));

app.get('/api/check', (req, res) => {
    res.json({ status: 'ok' });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Exercise app listening at http://0.0.0.0:${port}`);
}); 