#!/usr/bin/env node

/**
 * Generate a /do skill from the template and configuration
 *
 * Usage:
 *   node generate-skill.js <config-file> [output-file]
 *
 * Examples:
 *   node generate-skill.js examples/sam-config.json
 *   node generate-skill.js my-config.json ../../commands/do.md
 */

const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node generate-skill.js <config-file> [output-file]');
  console.error('');
  console.error('Examples:');
  console.error('  node generate-skill.js examples/sam-config.json');
  console.error('  node generate-skill.js my-config.json ../../commands/do.md');
  process.exit(1);
}

const configFile = args[0];
const outputFile = args[1] || '../../commands/do.md';

// Check if config file exists
if (!fs.existsSync(configFile)) {
  console.error(`Error: Config file not found: ${configFile}`);
  process.exit(1);
}

// Load template
const templatePath = path.join(__dirname, 'do-template.md');
if (!fs.existsSync(templatePath)) {
  console.error(`Error: Template not found: ${templatePath}`);
  process.exit(1);
}

console.log('Loading template...');
const templateSource = fs.readFileSync(templatePath, 'utf8');

// Load config
console.log(`Loading config from ${configFile}...`);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));

// Register custom Handlebars helpers
Handlebars.registerHelper('join', function(arr, separator) {
  return arr.join(separator);
});

// Compile and execute template
console.log('Processing template...');
const template = Handlebars.compile(templateSource);
const output = template(config);

// Ensure output directory exists
const outputDir = path.dirname(outputFile);
if (!fs.existsSync(outputDir)) {
  console.log(`Creating output directory: ${outputDir}`);
  fs.mkdirSync(outputDir, { recursive: true });
}

// Write output
console.log(`Writing to ${outputFile}...`);
fs.writeFileSync(outputFile, output);

console.log('✓ Done!');
console.log('');
console.log('Next steps:');
console.log('  1. Review the generated file');
console.log('  2. Test the workflow with a sample task');
console.log('  3. Customize further if needed');
