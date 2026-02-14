/**
 * Signal Authentication Script
 *
 * Register and verify a phone number with Signal via signal-cli.
 *
 * Usage:
 *   npx tsx src/signal-auth.ts register [--voice|--sms]
 *   npx tsx src/signal-auth.ts verify <CODE>
 *   npx tsx src/signal-auth.ts status
 *
 * Set SIGNAL_PHONE_NUMBER env var or pass interactively.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const SIGNAL_CLI = process.env.SIGNAL_CLI_PATH || 'signal-cli';
const CONFIG_DIR = path.resolve('store', 'signal-auth');
const STATUS_FILE = path.resolve('store', 'signal-auth-status.txt');

function writeStatus(status: string): void {
  fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
  fs.writeFileSync(STATUS_FILE, status);
}

function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  const command = process.argv[2];
  let phoneNumber = process.env.SIGNAL_PHONE_NUMBER;

  if (!phoneNumber) {
    phoneNumber = await askQuestion(
      'Enter phone number (with country code, e.g. +14155551234): ',
    );
  }

  if (!phoneNumber || !phoneNumber.startsWith('+')) {
    console.error('Phone number must start with + (e.g. +14155551234)');
    process.exit(1);
  }

  switch (command) {
    case 'register': {
      const useVoice = process.argv.includes('--voice');
      const method = useVoice ? 'voice call' : 'SMS';
      console.log(`Registering ${phoneNumber} via ${method}...`);

      try {
        const args = [
          '--config',
          CONFIG_DIR,
          '-a',
          phoneNumber,
          'register',
        ];
        if (useVoice) args.push('--voice');

        execFileSync(SIGNAL_CLI, args, { stdio: 'inherit' });
        writeStatus('registered_pending_verify');
        console.log(
          '\nRegistration request sent. You should receive a verification code.',
        );
        console.log(
          `Run: SIGNAL_PHONE_NUMBER=${phoneNumber} npx tsx src/signal-auth.ts verify <CODE>`,
        );
      } catch {
        writeStatus('register_failed');
        console.error('Registration failed. Check signal-cli output above.');
        process.exit(1);
      }
      break;
    }

    case 'verify': {
      const code = process.argv[3];
      if (!code) {
        console.error('Usage: npx tsx src/signal-auth.ts verify <CODE>');
        process.exit(1);
      }
      console.log(`Verifying ${phoneNumber} with code ${code}...`);

      try {
        execFileSync(
          SIGNAL_CLI,
          ['--config', CONFIG_DIR, '-a', phoneNumber, 'verify', code],
          { stdio: 'inherit' },
        );
        writeStatus('authenticated');
        console.log('\nSuccessfully verified! Signal is ready to use.');
        console.log(
          `\nAdd to your environment:\n  export SIGNAL_PHONE_NUMBER=${phoneNumber}`,
        );
      } catch {
        writeStatus('verify_failed');
        console.error('Verification failed. Check signal-cli output above.');
        process.exit(1);
      }
      break;
    }

    case 'status': {
      if (fs.existsSync(STATUS_FILE)) {
        const status = fs.readFileSync(STATUS_FILE, 'utf-8').trim();
        console.log(`Status: ${status}`);
      } else {
        console.log('Status: not registered');
      }

      // Check if signal-cli can list groups (proves auth works)
      try {
        const output = execFileSync(
          SIGNAL_CLI,
          ['--config', CONFIG_DIR, '-a', phoneNumber, 'listGroups'],
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        );
        console.log(`Groups:\n${output || '(none)'}`);
      } catch {
        console.log('Cannot connect to Signal (not registered or auth expired)');
      }
      break;
    }

    default:
      console.log('Signal Authentication for NanoClaw\n');
      console.log('Usage:');
      console.log(
        '  npx tsx src/signal-auth.ts register [--voice]  Register phone number',
      );
      console.log(
        '  npx tsx src/signal-auth.ts verify <CODE>        Verify with code',
      );
      console.log(
        '  npx tsx src/signal-auth.ts status               Check auth status',
      );
      console.log(
        '\nSet SIGNAL_PHONE_NUMBER env var or enter interactively.',
      );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
