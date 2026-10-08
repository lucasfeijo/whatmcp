import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const preview=`http://127.0.0.1:${process.env.WHATMCP_PREVIEW_PORT??'1421'}`;
export default defineConfig({plugins:[react()],server:{port:1420,strictPort:true,proxy:{'/api':preview,'/shell':preview}},clearScreen:false});
