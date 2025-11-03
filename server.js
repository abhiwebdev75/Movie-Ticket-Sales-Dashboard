// --- REQUIRED MODULES ---
const express = require('express');
const cors = require('cors');
const path = require('path');
const mysql = require('mysql2/promise');

const app = express();
const PORT = 5500;

// --- MIDDLEWARE CONFIGURATION ---
app.use(cors());
app.use(express.static(path.join(__dirname, '/')));
app.use(express.json()); // Middleware to parse incoming JSON bodies (CRITICAL for POST requests)

// --- DATABASE CONFIGURATION ---
const dbConfig = {
    host: 'localhost',
    user: 'root',
    // NOTE: For a real-world application, use environment variables instead of hardcoding passwords.
    password: 'Codelover@988', 
    database: 'movies', 
    port: 8000 // KEPT AS REQUESTED by the user.
};

// --- DATABASE HELPER FUNCTION WITH DEBUGGING ---
async function queryDatabase(sql, params = []) {
    let connection;
    try {
        console.log("[DB] Connecting to MySQL...");
        connection = await mysql.createConnection(dbConfig);
        console.log(`[DB] Connected. Executing SQL: ${sql.trim().replace(/\s+/g," ").substring(0,200)} with params:`, params);
        const [rows] = await connection.execute(sql, params); 
        console.log(`[DB] Query executed. Returned ${rows.length} rows.`);
        return rows;
    } catch (error) {
        console.error("[DB ERROR]", error.message, "\n", error);
        throw new Error("Failed to fetch data from MySQL. Check database connection and SQL syntax.");
    } finally {
        if (connection) {
            console.log("[DB] Closing connection.");
            await connection.end();
        }
    }
}

// ------------------------------
// CUSTOM ID GENERATION LOGIC
// ------------------------------

/**
 * Generates the next sequential ticket ID based on the highest existing ID.
 * Assumes the ID format is 'TKT' followed by numbers (e.g., TKT00000001).
 */
async function generateNextTicketId() {
    // 1. Get the current maximum numeric part of the ticket_id
    const sqlMaxId = `
        SELECT 
            CAST(SUBSTRING(MAX(ticket_id), 4) AS UNSIGNED) AS max_id 
        FROM ticket_sales;
    `;
    const results = await queryDatabase(sqlMaxId);
    let maxId = results[0]?.max_id || 0;

    // 2. Increment the ID
    const nextNumericId = maxId + 1;

    // 3. Format the new ID string (TKT + zero-padded number, assuming 7 digits padding for now)
    const padding = 7; 
    const paddedId = String(nextNumericId).padStart(padding, '0');
    
    return 'TKT' + paddedId;
}

// ------------------------------
// NEW ENDPOINT FOR FRONTEND ID FETCH
// ------------------------------
app.get('/api/next_ticket_id', async (req, res) => {
    try {
        const nextId = await generateNextTicketId();
        res.json({ ticket_id: nextId });
    } catch (error) {
        console.error("[API ERROR] /api/next_ticket_id:", error.message);
        res.status(500).json({ message: "Failed to generate ticket ID.", details: error.message });
    }
});


// ------------------------------
// CENTRAL FILTERING LOGIC
// ------------------------------
function buildFilter(query) {
    const filters = [];
    const params = [];
    console.log('[DEBUG] buildFilter() incoming query:', query);

    if (query.city && query.city !== 'All') {
        filters.push('City = ?');
        params.push(query.city);
    }
    if (query.theatre && query.theatre !== 'All') {
        filters.push('theatre_name = ?');
        params.push(query.theatre);
    }
    if (query.showTime && query.showTime !== 'All') { 
        filters.push('show_time = ?');
        params.push(query.showTime);
    }
    if (query.seatCategory && query.seatCategory !== 'All') { 
        filters.push('seat_category = ?');
        params.push(query.seatCategory);
    }
    
    // FIX: Use booking_date_start/end keys for date filtering
    if (query.booking_date_start) {
        filters.push('booking_date >= ?');
        params.push(query.booking_date_start);
    }
    if (query.booking_date_end) {
        filters.push('booking_date <= ?');
        params.push(query.booking_date_end);
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    console.log('[DEBUG] buildFilter() produced:', { whereClause, params });
    return { whereClause, params };
}

// --- NEW ENDPOINT: INSERT New Ticket Sale ---
app.post('/api/new_sale', async (req, res) => {
    console.log("[API] POST /api/new_sale called with body:", req.body);
    const data = req.body;

    const newTicketId = data.ticket_id;
    
    if (!newTicketId || !newTicketId.startsWith('TKT')) {
        return res.status(400).json({ message: "Missing or invalid Ticket ID from form submission." });
    }

    // FIX: Define columns in the exact order required for SQL insertion.
    // The insertion logic now maps directly from this known order to the 'data' object.
    const columns = [
        'ticket_id', 'movie_title', 'movie_id', 'theatre_name', 'City', 'show_time', 
        'seat_category', 'booking_date', 'release_date', 'ticket_price', 
        'no_of_persons', 'payment_Amount', 'payment_type', 'ticket_type', 
        'age', 'adult', 'sex', 'language', 'original_language'
    ];
    
    // FIX: Manually construct the values array in the correct order.
    // This resolves the misalignment that was causing City to be inserted as NULL.
    const values = columns.map(col => {
        let val = data[col];
        
        // Handle City value explicitly to ensure it's not converted to null if it's an empty string or undefined
        if (col === 'City' || col === 'city') {
             // Use 'City' key for SQL but check both possible JSON keys just in case.
             val = data.city || data.City;
             if (val === '') val = null; // Convert empty string to NULL if desired
        }
        
        // Handle boolean conversion for 'adult'
        if (col === 'adult') {
            return val === 'true' || val === true ? TRUE : FALSE ; 
        }
        
        // Handle explicit conversion of null/undefined to SQL NULL
        if (val === null || val === undefined || val === '') {
            return null;
        }
        
        return val;
    });


    const placeholders = columns.map(() => '?').join(', ');
    const sql = `
        INSERT INTO ticket_sales (${columns.join(', ')}) 
        VALUES (${placeholders})
    `;

    try {
        await queryDatabase(sql, values);
        res.status(201).json({ message: `Ticket sale recorded successfully with ID: ${newTicketId}`, ticket_id: newTicketId, data: data });
    } catch (error) {
        console.error("[API ERROR] /api/new_sale:", error.message);
        res.status(500).json({ message: "Database insertion failed: " + error.message });
    }
});

// --- API ENDPOINTS FOR ANALYTICS (Read-Only) ---

app.get('/api/kpis', async (req, res) => {
    console.log("[API] GET /api/kpis called with query:", req.query);
    try {
        const { whereClause, params } = buildFilter(req.query);
        const sql = `
            SELECT
                SUM(payment_Amount) AS total_revenue,
                COUNT(ticket_id) AS total_tickets,
                SUM(no_of_persons) AS total_Persons,
                AVG(ticket_price) AS avg_ticket_price
            FROM ticket_sales
            ${whereClause};
        `;
        const results = await queryDatabase(sql, params);
        const kpis = results[0] || {};
        
        // FIX: Ensure keys match client expectation (camelCase) for the dashboard to display data
        res.json({
            totalRevenue: parseFloat(kpis.total_revenue || 0),
            totalTickets: parseInt(kpis.total_tickets || 0),
            totalPersons: parseInt(kpis.total_Persons || 0),
            avgTicketPrice: parseFloat(kpis.avg_ticket_price || 0)
        });
    } catch (error) {
        console.error("[API ERROR] /api/kpis:", error.message);
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/top_movies', async (req, res) => {
    console.log("[API] GET /api/top_movies called with query:", req.query);
    try {
        const { whereClause, params } = buildFilter(req.query);
        const sql = `
            SELECT
                movie_title AS label,
                SUM(payment_Amount) AS value
            FROM ticket_sales
            ${whereClause}
            GROUP BY movie_title
            ORDER BY value DESC
            LIMIT 5;
        `;
        const results = await queryDatabase(sql, params);
        const labels = results.map(row => row.label);
        const data = results.map(row => parseFloat(row.value));
        res.json({ labels, data });
    } catch (error) {
        console.error("[API ERROR] /api/top_movies:", error.message);
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/cities', async (req, res) => {
    console.log("[API] GET /api/cities called with query:", req.query);
    try {
        const { whereClause, params } = buildFilter(req.query);
        const sql = `
            SELECT
                City AS label,
                SUM(payment_Amount) AS value
            FROM ticket_sales
            ${whereClause}
            GROUP BY City
            ORDER BY value DESC;
        `;
        const results = await queryDatabase(sql, params);
        const labels = results.map(row => row.label);
        const data = results.map(row => parseFloat(row.value));
        res.json({ labels, data });
    } catch (error) {
        console.error("[API ERROR] /api/cities:", error.message);
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/revenue_trend', async (req, res) => {
    console.log("[API] GET /api/revenue_trend called with query:", req.query);
    try {
        const { whereClause, params } = buildFilter(req.query);
        const sql = `
            SELECT
                DATE_FORMAT(booking_date, '%Y-%m-%d') AS label,
                SUM(payment_Amount) AS value
            FROM ticket_sales
            ${whereClause}
            GROUP BY label
            ORDER BY label ASC;
        `;
        const results = await queryDatabase(sql, params);
        const labels = results.map(row => row.label);
        const data = results.map(row => parseFloat(row.value));
        res.json({ labels, data });
    } catch (error) {
        console.error("[API ERROR] /api/revenue_trend:", error.message);
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/theatres', async (req, res) => {
    console.log("[API] GET /api/theatres called with query:", req.query);
    try {
        const { whereClause, params } = buildFilter(req.query);
        const sql = `
            SELECT
                theatre_name AS label,
                SUM(payment_Amount) AS value 
            FROM ticket_sales
            ${whereClause}
            GROUP BY theatre_name
            ORDER BY value DESC
            LIMIT 10;
        `;
        const results = await queryDatabase(sql, params);
        const labels = results.map(row => row.label);
        const data = results.map(row => parseFloat(row.value));
        res.json({ labels, data });
    } catch (error) {
        console.error("[API ERROR] /api/theatres:", error.message);
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/age_groups', async (req, res) => {
    console.log("[API] GET /api/age_groups called with query:", req.query);
    try {
        const { whereClause, params } = buildFilter(req.query);
        const sql = `
            SELECT
                CASE
                    WHEN age IS NULL THEN 'Unknown'
                    WHEN age < 18 THEN 'Under 18'
                    WHEN age BETWEEN 18 AND 25 THEN '18-25'
                    WHEN age BETWEEN 26 AND 40 THEN '26-40'
                    WHEN age BETWEEN 41 AND 60 THEN '41-60'
                    ELSE '60+'
                END AS label,
                SUM(no_of_persons) AS value
            FROM ticket_sales
            ${whereClause}
            GROUP BY label
            ORDER BY label;
        `;
        const results = await queryDatabase(sql, params);
        const labels = results.map(row => row.label);
        const data = results.map(row => parseInt(row.value));
        res.json({ labels, data });
    } catch (error) {
        console.error("[API ERROR] /api/age_groups:", error.message);
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/seat_categories', async (req, res) => {
    console.log("[API] GET /api/seat_categories called with query:", req.query);
    try {
        const { whereClause, params } = buildFilter(req.query);
        const sql = `
            SELECT
                seat_category AS label,
                SUM(payment_Amount) AS value 
            FROM ticket_sales
            ${whereClause}
            GROUP BY seat_category
            ORDER BY value DESC;
        `;
        const results = await queryDatabase(sql, params);
        const labels = results.map(row => row.label);
        const data = results.map(row => parseFloat(row.value));
        res.json({ labels, data });
    } catch (error) {
        console.error("[API ERROR] /api/seat_categories:", error.message);
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/metadata', async (req, res) => {
    console.log("[API] GET /api/metadata called with query:", req.query);
    try {
        // Fetch all distinct options for filters/form fields
        const cities = await queryDatabase("SELECT DISTINCT City FROM ticket_sales WHERE City IS NOT NULL ORDER BY City;");
        const theatres = await queryDatabase("SELECT DISTINCT theatre_name FROM ticket_sales WHERE theatre_name IS NOT NULL ORDER BY theatre_name;");
        const showtimes = await queryDatabase("SELECT DISTINCT show_time FROM ticket_sales WHERE show_time IS NOT NULL ORDER BY show_time;");
        const categories = await queryDatabase("SELECT DISTINCT seat_category FROM ticket_sales WHERE seat_category IS NOT NULL ORDER BY seat_category;");
        
        res.json({
            cities: cities.map(r => r.City),
            theatres: theatres.map(p => p.theatre_name),
            showtimes: showtimes.map(c => c.show_time),
            categories: categories.map(c => c.seat_category)
        });
    } catch (error) {
        console.error("[API ERROR] /api/metadata:", error.message);
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/sales_data', async (req, res) => {
    console.log("[API] GET /api/sales_data called with query for table data:", req.query);
    try {
        const { whereClause, params } = buildFilter(req.query);
        const sql = `
            SELECT
                ticket_id, movie_title, City, theatre_name,
                show_time, seat_category, ticket_price,
                no_of_persons, age, booking_date, payment_Amount
            FROM ticket_sales
            ${whereClause}
            ORDER BY booking_date DESC;
        `;
        const results = await queryDatabase(sql, params);
        res.json(results);
    } catch (error) {
        console.error("[API ERROR] /api/sales_data:", error.message);
        res.status(500).json({ message: error.message });
    }
});


app.listen(PORT, () => {
    console.log("\n======================================================");
    console.log(`🚀 Node.js Backend Running on http://localhost:${PORT}`);
    console.log(`Database: ${dbConfig.database} | Host: ${dbConfig.host} | MySQL port: ${dbConfig.port}`);
    console.log("======================================================\n");
});
