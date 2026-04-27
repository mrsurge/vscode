import * as editor_main_exports from './out-monaco-editor-core/esm/vs/editor/editor.main.js';
import './te2_basic_languages_shim.js';

async function loadMonaco() {
  return editor_main_exports;
}
export {
  loadMonaco
};
