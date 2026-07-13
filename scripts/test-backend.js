/* 
import dotenv from 'dotenv';
dotenv.config();

// Reemplaza esto con la URL que te dio Railway al finalizar el despliegue
const PRODUCTION_API_URL = 'https://railway.app'; 
*/


// Ejemplos de uso:
// node test-backend.js https://app.railway.com
// mode test-backend.js

const args = process.argv.slice(2);
const apiURL = args[2]; // Opcionalmente toma el URL del primer argumento de la línea de commando
const PRODUCTION_API_URL = apiURL || 'aakstrapi-production-2140.up.railway.app';  

async function runDiagnostic() {
  console.log('🔍 Iniciando prueba de diagnóstico en el servidor de producción...');
  console.log(`🌐 Apuntando a: ${PRODUCTION_API_URL}/api/items`);

  try {
    const start = Date.now();
    const response = await fetch(`${PRODUCTION_API_URL}/api/items`);
    const duration = Date.now() - start;

    if (!response.ok) {
      throw new Error(`El servidor respondió con código de estado HTTP: ${response.status}`);
    }

    const data = await response.json();

    console.log('\n✅ --- RESULTADO DEL DIAGNÓSTICO ---');
    console.log(`• Estado HTTP: ${response.status} OK`);
    console.log(`• Tiempo de Respuesta: ${duration}ms`);
    console.log(`• Tipo de Estructura: ${Array.isArray(data) ? 'Arreglo JSON Válido' : 'Desconocido'}`);
    console.log(`• Total de Objetos Iniciales en Neon: ${data.length}`);
    console.log('------------------------------------\n');
    console.log('🚀 ¡Diagnóstico Exitoso! El backend está operativo y conectado a Neon.');

  } catch (error) {
    console.error('\n❌ --- FALLO EN EL DIAGNÓSTICO ---');
    console.error(`Causa del error: ${error.message}`);
    console.error('Sugerencia: Revisa los logs de Railway y verifica que las variables de la base de datos coincidan.');
    console.log('-----------------------------------\n');
  }
}

runDiagnostic();
