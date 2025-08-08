// This file MUST be placed in the `api` directory of your project
// to correctly handle POST requests at the `/api/extract-invoice` endpoint.

const { GoogleGenerativeAI } = require('@google/generative-ai');

module.exports = async (request, response) => {
  // Set CORS headers to allow requests from the frontend
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight OPTIONS request
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  // Ensure the request method is POST
  if (request.method !== 'POST') {
    return response.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    // Check if the API key is present in environment variables
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('GEMINI_API_KEY not found in environment variables');
      return response.status(500).json({ error: 'API key is not configured on the server.' });
    }

    // Get the data from the request body
    const { imageData, mimeType } = request.body;
    
    // Validate the request body
    if (!imageData || !mimeType) {
      return response.status(400).json({ error: 'Missing imageData or mimeType in request body.' });
    }

    // Initialize the Generative AI model
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    // Define the prompt for the AI model
    const prompt = `You are an expert invoice data extraction system. Analyze this invoice image and extract the following information in JSON format:

{
  "invoiceNumber": "string | null",
  "vendorName": "string | null",
  "invoiceDate": "YYYY-MM-DD | null",
  "dueDate": "YYYY-MM-DD | null",
  "totalAmount": "number | null",
  "currency": "string | null",
  "lineItems": [
    {
      "product": "string | null",
      "quantity": "number | null",
      "unitPrice": "number | null",
      "totalPrice": "number | null"
    }
  ]
}

Important rules:
1. Return ONLY valid JSON, with no additional text or markdown formatting.
2. If a field is not found, use null for strings and numbers.
3. Parse all monetary values as numbers.
4. Ensure dates are in YYYY-MM-DD format.`;

    const imagePart = {
      inlineData: {
        data: imageData,
        mimeType: mimeType
      }
    };
    
    // Use the older, more compatible `generateContent` signature
    const result = await model.generateContent([prompt, imagePart]);
    const responseText = result.response.text();

    let extractedData;
    try {
      extractedData = JSON.parse(responseText);
    } catch (parseError) {
      // If parsing fails, try to clean the text
      const cleanedText = responseText.replace(/```json\n?/, '').replace(/\n?```$/, '').trim();
      try {
        extractedData = JSON.parse(cleanedText);
      } catch (finalParseError) {
        console.error('Final JSON parsing failed:', finalParseError);
        return response.status(500).json({
          error: 'Failed to parse AI response.',
          rawResponse: responseText
        });
      }
    }

    return response.status(200).json(extractedData);

  } catch (error) {
    console.error('Error in serverless function:', error);
    return response.status(500).json({
      error: 'Failed to process invoice.',
      details: error.message
    });
  }
};
