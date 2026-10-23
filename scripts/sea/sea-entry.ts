/* eslint-disable @typescript-eslint/no-require-imports */
const { lazyModuleKey, registerLazyModule } = require('../../dist/bootstrap/lazy-module');

registerLazyModule(lazyModuleKey.wfConfigLoader, require('../../dist/config/wf-config-loader'));
registerLazyModule(lazyModuleKey.appModule, require('../../dist/app.module'));
registerLazyModule(lazyModuleKey.jiti, require('jiti'));

require('../../dist/main');
