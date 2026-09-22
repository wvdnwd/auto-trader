import { NodeServer } from '@bitdev/node.node-server';

export default NodeServer.from({
  name: 'trading-service',
  mainPath: import.meta.resolve('./trading-service.app-root.js'),
});
