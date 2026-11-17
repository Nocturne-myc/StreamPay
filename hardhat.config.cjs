require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
require('@nomicfoundation/hardhat-verify');
require('solidity-coverage');
const { subtask } = require('hardhat/config');
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require('hardhat/builtin-tasks/task-names');

// Use the pinned local compiler; compilation does not download a compiler.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }, _hre, runSuper) => {
  if (solcVersion !== '0.8.28') return runSuper();
  return {
    compilerPath: require.resolve('solc/soljson.js'),
    isSolcJs: true,
    version: '0.8.28',
    longVersion: require('solc').version()
  };
});

module.exports = {
  solidity: {
    version: '0.8.28',
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai' }
  },
  paths: { tests: './tests', cache: './.build/cache', artifacts: './.build/artifacts' },
  networks: {
    hardhat: { chainId: 31337, hardfork: 'shanghai' },
    localhost: { url: 'http://127.0.0.1:8545', chainId: 31337 },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || 'http://127.0.0.1:1',
      chainId: 11155111,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []
    }
  },
  etherscan: { apiKey: process.env.ETHERSCAN_API_KEY || '' },
  mocha: { timeout: 120000, reporter: process.env.RECORD_TESTS ? require.resolve('./scripts/test-reporter.cjs') : 'spec',
    grep: process.env.STREAMPAY_COVERAGE ? /T-[CSA]\d+/ : undefined }
};
