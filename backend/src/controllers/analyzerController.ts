import { Request, Response } from 'express';
import { GoogleGenAI, Type } from '@google/genai';

// Initialize the Google Gen AI client with your API key
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export const analyzeItem = async (req: Request, res: Response): Promise<void> => {
  const adminToken = req.headers['x-admin-token'];
  const { imageUrl } = req.body;

  // Security guard: Ensure only you can invoke AI operations
  if (adminToken !== process.env.ADMIN_TOKEN) {
    res.status(401).json({ error: 'Unauthorized administrative access.' });
    return;
  }

  if (!imageUrl) {
    res.status(400).json({ error: 'Missing required parameter: imageUrl.' });
    return;
  }

  try {
    // Define a strict schema to force Gemini to return exactly what the database expects
    const schema = {
      type: Type.OBJECT,
      properties: {
        title: {
          type: Type.STRING,
          description: 'A clean, short title for the item. Max 50 characters.',
        },
        category: {
          type: Type.STRING,
          description: 'Must match exactly one of these 15 values: Kitchen, Electronics, Decor, Books, Media, Clothing, Bedding, Shoes, Accessories, Bathroom, Office, Utilities, Cleaning, Sports, Misc.',
        },
        description: {
          type: Type.STRING,
          description: 'A brief, friendly 1-2 sentence summary of the object condition or book overview.',
        },
        infoUrl: {
          type: Type.STRING,
          description: 'A valid external search link (like Goodreads for books, Amazon, or a general product info link). Return null if not applicable.',
          nullable: true,
        },
      },
      required: ['title', 'category', 'description'],
    };

    // Download the image buffer directly from Vercel Blobs to feed it to the model
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      res.status(400).json({ error: 'Failed to fetch the uploaded file from image hosting.' });
      return;
    }
    const arrayBuffer = await imageResponse.arrayBuffer();
    const imagePart = {
      inlineData: {
        data: Buffer.from(arrayBuffer).toString('base64'),
        mimeType: imageResponse.headers.get('content-type') || 'image/jpeg',
      },
    };

    // Call the Gemini model with a structured system instruction
    const response = await ai.models.generateContent({
      model: 'Gemini 3.1 Flash-Lite', // Lightning-fast and highly precise for visual extraction
      contents: [
        imagePart,
        'Analyze this photo of an item I want to give away for my moving sale. Extract its details.',
      ],
      config: {
        systemInstruction: 'You are an expert inventory cataloger. Analyze the photo and output data following the required JSON schema schema exactly.',
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
