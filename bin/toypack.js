#! /usr/bin/env node
const path = require("path");

const Compiler = require("./lib/Compiler");

const config = require(path.resolve("webpack.config.js"));
const compiler = new Compiler(config);
compiler.hooks.entry.call(compiler);

compiler.run();