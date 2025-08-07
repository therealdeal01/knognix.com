const { GoogleGenerativeAI } = require('@google/generative-ai');

module.exports = async (request, response) => {
  // Set CORS headers
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  if (request.method !== 'POST') {
    return response.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('GEMINI_API_KEY not found in environment variables');
      return response.status(500).json({ error: 'API key is not configured.' });
    }

    // Get the data from the request
    const { imageData, mimeType } = request.body;
    
    if (!imageData || !mimeType) {
      return response.status(400).json({ error: 'Missing imageData or mimeType' });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const prompt = `You are an expert invoice data extraction system. Analyze this invoice image and extract the following information in JSON format:

{
  "invoiceNumber": "string",
  "date": "YYYY-MM-DD",
  "dueDate": "YYYY-MM-DD",
  "vendor": {
    "name": "string",
    "address": "string",
    "email": "string",
    "phone": "string"
  },
  "billTo": {
    "name": "string",
    "address": "string",
    "email": "string",
    "phone": "string"
  },
  "items": [
    {
      "description": "string",
      "quantity": number,
      "unitPrice": number,
      "total": number
    }
  ],
  "subtotal": number,
  "tax": number,
  "total": number,
  "currency": "string"
}

Important rules:
1. Return ONLY valid JSON, no additional text
2. If a field is not found, use null for strings and 0 for numbers
3. Parse all monetary values as numbers (remove currency symbols)
4. Ensure dates are in YYYY-MM-DD format
5. Be precise with item descriptions and quantities`;

    const imagePart = {
      inlineData: {
        data: imageData.split(',')[1], // Remove data:image/jpeg;base64, prefix
        mimeType: mimeType
      }
    };

    const result = await model.generateContent([prompt, imagePart]);
    const responseText = result.response.text();

    // Clean and parse the response
    let cleanedText = responseText.trim();
    if (cleanedText.startsWith('```json')) {
      cleanedText = cleanedText.replace(/```json\n?/, '').replace(/\n?```$/, '');
    } else if (cleanedText.startsWith('```')) {
      cleanedText = cleanedText.replace(/```\n?/, '').replace(/\n?```$/, '');
    }

    try {
      const extractedData = JSON.parse(cleanedText);
      return response.status(200).json(extractedData);
    } catch (parseError) {
      console.error('JSON parsing error:', parseError);
      console.error('Raw response:', responseText);
      return response.status(500).json({ 
        error: 'Failed to parse AI response', 
        rawResponse: responseText 
      });
    }

  } catch (error) {
    console.error('Error in serverless function:', error);
    return response.status(500).json({ 
      error: 'Failed to process invoice.',
      details: error.message 
    });
  }
};
