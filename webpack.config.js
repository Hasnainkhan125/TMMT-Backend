const path = require('path');
const nodeExternals = require('webpack-node-externals');

module.exports = {
  mode: 'production',
  devtool: 'source-map', 
  entry: './index.js', // Adjust to your entry file
  target: 'node', // Specify Node.js target
  externals: [nodeExternals()], // Exclude node_modules
  output: {
    path: path.resolve(__dirname, 'dist'), // Output folder
    filename: 'bundle.js', // Output file
    libraryTarget: 'commonjs2', // Module system
  },
  module: {
    rules: [
      {
        test: /\.js$/, // Transform JS files
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader', // Babel loader (optional)
          options: {
            presets: ['@babel/preset-env'],
          },
        },
      },
    ],
  },
};
