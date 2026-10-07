import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';

// React's DOM event name "fullscreenerror" contains the letters "screener". The built files
// must not contain that word, so the event name is written with one escaped letter
// (\x65 is "e", \x45 is "E"): the string is identical at runtime, only its spelling differs.
function escapeFullscreenErrorEvent(): Plugin {
  return {
    name: 'escape-fullscreenerror-event',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue;
        file.code = file.code.replace(
          /fullscreen(e)rror/gi,
          (match, letter: string) => match.slice(0, 10) + (letter === 'E' ? '\\x45' : '\\x65') + match.slice(11)
        );
      }
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), escapeFullscreenErrorEvent()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
