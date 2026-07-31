const path = require('node:path');

const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');

module.exports = {
  mode: 'development',
  entry: './src/index.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.js',
  },
  devtool: 'eval-source-map',
  plugins: [
    new HtmlWebpackPlugin({ title: 'AgentLens webpack demo' }),
    new webpack.DefinePlugin({
      'process.env.AGENTLENS_PORT': JSON.stringify(process.env.AGENTLENS_PORT ?? '8631'),
    }),
  ],
  devServer: {
    host: '127.0.0.1',
    port: Number(process.env.WEBPACK_PORT ?? '5275'),
  },
};
