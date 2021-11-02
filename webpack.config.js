const path = require('path');

module.exports = {
    target: 'node',
    mode: 'none',
    entry: './index.js',
    node: {
        global: false,
        __filename: false,
        __dirname: false,
    },
    output: {
        filename: 'index.js',
        path: path.resolve(__dirname, 'dist'),
    },
};