import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests',testIgnore:process.env.HELPER_PYTHON?[]:['**/handoff.spec.mjs'],workers:1,use:{channel:process.env.CI?undefined:'chrome',headless:true},
  webServer:{command:'npm start',url:process.env.BASE_URL||'http://localhost:4173',reuseExistingServer:true},
  reporter:'list'});
