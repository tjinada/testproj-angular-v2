require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const dynatraceRoutes = require('./routes/dynatrace-routes');
const configRoutes = require('./routes/config-routes');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());

// API Routes
app.use('/api/traces', dynatraceRoutes);
app.use('/api/config', configRoutes);

// Serve Angular static files in production
const distPath = path.join(__dirname, '..', 'dist', 'testproj-angular-v2', 'browser');
app.use(express.static(distPath));
app.get('/*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
