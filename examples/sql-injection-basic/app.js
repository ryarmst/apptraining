const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const { exec } = require('child_process');

const app = express();
const port = process.env.APP_PORT || 8080;

// Middleware
app.use(morgan('dev'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Database setup
const db = new sqlite3.Database(path.join(__dirname, 'db', 'exercise.db'));

// Initialize database with sample data
db.serialize(() => {
    // Users table with admin account
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT,
        password TEXT,
        role TEXT
    )`);

    // Hidden table with sensitive data
    db.run(`CREATE TABLE IF NOT EXISTS sensitive_data (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        credit_card TEXT,
        ssn TEXT
    )`);

    // Insert sample data if not exists
    db.get('SELECT COUNT(*) as count FROM users', (err, row) => {
        if (err || row.count === 0) {
            db.run(`INSERT INTO users (username, password, role) VALUES 
                ('admin', 'super_secret_admin_pw', 'admin'),
                ('john', 'password123', 'user'),
                ('jane', 'letmein', 'user')`);

            db.run(`INSERT INTO sensitive_data (user_id, credit_card, ssn) VALUES 
                (1, '4532-7163-9017-3421', '123-45-6789'),
                (2, '5421-8765-1234-5678', '987-65-4321'),
                (3, '6011-2345-6789-0123', '456-78-9012')`);
        }
    });
});

// Routes
app.get('/', (req, res) => {
    res.render('login');
});

// Vulnerable login endpoint
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    // Vulnerable SQL query
    const query = `SELECT * FROM users WHERE username = '${username}' AND password = '${password}'`;
    
    db.get(query, (err, user) => {
        if (err) {
            console.error('Login error:', err);
            return res.status(500).json({ error: 'Database error' });
        }

        if (user) {
            // Check if this was a successful SQL injection attempt
            if (username.toLowerCase().includes('admin') && username.includes("'")) {
                notifyCompletion('auth_bypass', 'Successful authentication bypass!');
            }
            res.render('dashboard', { user });
        } else {
            res.render('login', { error: 'Invalid credentials' });
        }
    });
});

// Vulnerable search endpoint
app.get('/search', (req, res) => {
    const { query } = req.query;
    
    if (!query) {
        return res.render('search');
    }

    // Vulnerable SQL query
    const sql = `SELECT u.username, s.credit_card, s.ssn 
                 FROM users u 
                 LEFT JOIN sensitive_data s ON u.id = s.user_id 
                 WHERE u.username LIKE '%${query}%'`;

    db.all(sql, (err, results) => {
        if (err) {
            console.error('Search error:', err);
            return res.status(500).json({ error: 'Database error' });
        }

        // Check if sensitive data was exposed
        if (results && results.some(r => r.credit_card && r.ssn)) {
            notifyCompletion('data_extract', 'Successfully extracted sensitive data!');
        }

        res.render('search', { results, query });
    });
});

// Helper function to notify exercise completion
function notifyCompletion(goal, message) {
    console.log(`Exercise goal achieved: ${goal} - ${message}`);
    exec('check-completion.sh ' + goal, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error executing check-completion: ${error}`);
            return;
        }
        console.log(`check-completion output: ${stdout}`);
    });
}

// Start server
app.listen(port, () => {
    console.log(`Exercise app listening at http://localhost:${port}`);
}); 