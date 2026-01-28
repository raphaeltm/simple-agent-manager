#!/usr/bin/env npx tsx
/**
 * Teardown script for Simple Agent Manager.
 * Removes deployed resources.
 */

import { execSync } from 'child_process';
import * as readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

function run(command: string): void {
  console.log(`$ ${command}`);
  try {
    execSync(command, { stdio: 'inherit' });
  } catch {
    console.log('(Command failed, continuing...)');
  }
}

async function main() {
  console.log('⚠️  Simple Agent Manager Teardown\n');
  console.log('This will remove all deployed resources.\n');
  console.log('─'.repeat(50) + '\n');

  const confirm = await ask('Are you sure you want to continue? (yes/no): ');
  if (confirm.toLowerCase() !== 'yes') {
    console.log('Aborted.');
    rl.close();
    return;
  }

  const deleteData = await ask('Delete database and stored data? (yes/no): ');
  const shouldDeleteData = deleteData.toLowerCase() === 'yes';

  console.log('\n🗑️  Starting teardown...\n');

  // Delete Cloudflare Worker
  console.log('Deleting API Worker...');
  run('wrangler delete --name simple-agent-manager-api');

  // Delete Cloudflare Pages
  console.log('\nDeleting Web Pages project...');
  run('wrangler pages project delete simple-agent-manager --yes');

  if (shouldDeleteData) {
    // Delete D1 database
    console.log('\nDeleting D1 database...');
    run('wrangler d1 delete simple-agent-manager --yes');

    // Delete KV namespace
    console.log('\nDeleting KV namespace...');
    run('wrangler kv:namespace delete --namespace-id <YOUR_KV_NAMESPACE_ID>');

    // Delete R2 bucket
    console.log('\nDeleting R2 bucket...');
    run('wrangler r2 bucket delete simple-agent-manager --yes');
  }

  console.log('\n' + '─'.repeat(50));
  console.log('\n✅ Teardown complete.');

  if (!shouldDeleteData) {
    console.log('\nNote: Database and storage were preserved.');
    console.log('To delete them manually:');
    console.log('  wrangler d1 delete simple-agent-manager');
    console.log('  wrangler kv:namespace delete --namespace-id <ID>');
    console.log('  wrangler r2 bucket delete simple-agent-manager');
  }

  rl.close();
}

main();
