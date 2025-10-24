import { createCodexServer } from './src/index.js';

const server = createCodexServer({
  codexBin: 'codex',
  workingDirectory: process.cwd(),
  codexDefaultArgs: ['--profile', 'gpt-oss-20b-lms'],
  defaultJson: true,
  defaultSkipGitCheck: true,
});

const tool = server._registeredTools['codex.exec'];
const extra = {
  signal: new AbortController().signal,
  sendNotification: async (notification) => {
    console.error('NOTIFY', JSON.stringify(notification));
  },
};

const run = async () => {
  const result = await tool.callback({
    prompt: 'Say hello world',
    json: true,
    skipGitRepoCheck: true,
  }, extra);
  console.log('RESULT', JSON.stringify(result));
};

run().catch((error) => {
  console.error('ERROR', error);
  process.exit(1);
});
