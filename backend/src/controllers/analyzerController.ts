import { Request, Response } from 'express';
import { GoogleGenAI, Type } from '@google/genai';

// Initialize the Google Gen AI client with your API key
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Máximo de imágenes que se envían a Gemini en una sola llamada multimodal.
 * Se analizan las PRIMERAS fotos de la lista ordenada del Item (índices 0..2).
 */
const MAX_IMAGES_TO_ANALYZE = 3;

export const analyzeItem = async (req: Request, res: Response): Promise<void> => {
  // La autenticación la garantiza el middleware requireAdminSession en la ruta.
  const { imageUrls } = req.body;

  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    res.status(400).json({
      error: 'Missing required parameter: imageUrls (arreglo con al menos 1 foto).'
    });
    return;
  }

  // Solo se analizan las primeras hasta 3 fotos de la lista ordenada.
  const targets = imageUrls.slice(0, MAX_IMAGES_TO_ANALYZE);

  try {
    // Define a strict schema to force Gemini to return exactly what the database expects
    const schema = {
      type: Type.OBJECT,
      properties: {
        title: {
          type: Type.STRING,
          description: 'Un título corto y claro para el objeto. Máximo 50 caracteres.',
        },
        category: {
          type: Type.STRING,
          description: 'Debe coincidir exactamente con uno de estos 15 valores: Kitchen, Electronics, Decor, Books, Media, Clothing, Bedding, Shoes, Accessories, Bathroom, Office, Utilities, Cleaning, Sports, Misc.',
        },
        description: {
          type: Type.STRING,
          description: 'Un resumen breve y amigable de 1-2 oraciones sobre el estado del objeto o resumen del libro. Responde en español.',
        },
        infoUrl: {
          type: Type.STRING,
          description: 'Un enlace de búsqueda basado en el siguiente formato de búsqueda `https://www.google.com.mx/search?q=term1+term2+more+terms`. Donde los términos de búsqueda sean en español. Devuelve null si no aplica.',
          nullable: true,
        },
      },
      required: ['title', 'category', 'description'],
    };

    // Descargar cada imagen (hasta 3) en paralelo desde Vercel Blobs para
    // alimentar al modelo como partes inlineData en UNA sola llamada.
    const downloaded = await Promise.all(
      targets.map(async (imageUrl: string) => {
        const imageResponse = await fetch(imageUrl);
        if (!imageResponse.ok) {
          throw new Error(`Failed to fetch uploaded file from image hosting: ${imageUrl}`);
        }
        const arrayBuffer = await imageResponse.arrayBuffer();
        return {
          inlineData: {
            data: Buffer.from(arrayBuffer).toString('base64'),
            mimeType: imageResponse.headers.get('content-type') || 'image/jpeg',
          },
        };
      })
    );

    // Prompt fijo (NO cambia según la cantidad de fotos): trata las imágenes
    // como vistas del mismo objeto y devuelve un solo JSON.
    const imageParts = downloaded as any[];
    const promptText =
      'Analiza el objeto que se muestra en las imágenes adjuntas. Si hay más de una imagen, ' +
      'son vistas del mismo objeto: úsalas como contexto complementario (detalles, etiquetas, ' +
      'estado, ángulos, daños). Devuelve un solo JSON con los datos del objeto. ' +
      'Verifica que el link infoURL sea actual, válido y relevante. Responde siempre en español.';

    // Call the Gemini model with a structured system instruction
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite', // Lightning-fast and highly precise for visual extraction
      contents: [
        ...imageParts,
        promptText,
      ],
      config: {
        systemInstruction: 'Eres un catalogador experto de inventario. Analiza las fotos y genera los datos siguiendo exactamente el esquema JSON requerido. Todas las respuestas deben estar en español.',
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    });

    const responseText = response.text;
    if (!responseText) {
      throw new Error('Empty payload returned from the Vision LLM engine.');
    }

    // Parse the safe JSON string straight out of the response block
    const parsedData = JSON.parse(responseText);

    res.status(200).json({
      success: true,
      data: parsedData,
    });

  } catch (error) {
    console.error('Vision analysis script failed:', error);
    res.status(500).json({ error: 'Internal system failure parsing item details via AI middleware.' });
  }
};
