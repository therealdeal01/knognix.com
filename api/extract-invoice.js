const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const { Poppler } = require('pdf-poppler');

module.exports = async (request, response) => {
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
    // --- Parse JSON body ---
    let rawBody = '';
    for await (const chunk of request) rawBody += chunk;
    let parsedBody;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch (err) {
      console.error('Invalid JSON body:', err.message);
      return response.status(400).json({ error: 'Invalid JSON payload.' });
    }

    let { imageData, mimeType } = parsedBody;

    console.log('Incoming file type:', mimeType);
    console.log('Incoming base64 length:', imageData ? imageData.length : 0);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('GEMINI_API_KEY not found in environment variables');
      return response.status(500).json({ error: 'API key is not configured on the server.' });
    }

    if (!imageData || !mimeType) {
      console.error('Missing imageData or mimeType in request body.');
      return response.status(400).json({ error: 'Missing imageData or mimeType in request body.' });
    }

    // --- Handle PDF conversion ---
    if (mimeType === 'application/pdf') {
      console.log('Converting PDF to PNG for Gemini...');
      const tempPdfPath = path.join('/tmp', `invoice-${Date.now()}.pdf`);
      const tempPngPath = path.join('/tmp', `invoice-${Date.now()}`);

      // Save PDF temporarily
      fs.writeFileSync(tempPdfPath, Buffer.from(imageData, 'base64'));

      const poppler = new Poppler();
      await poppler.convert(tempPdfPath, {
        format: 'png',
        out_dir: '/tmp',
        out_prefix: `invoice-${Date.now()}`,
        page: 1, // first page only
        dpi: 150
      });

      // Read converted PNG
      const pngFilePath = `${tempPngPath}-1.png`;
      const pngBuffer = fs.readFileSync(pngFilePath);
      imageData = pngBuffer.toString('base64');
      mimeType = 'image/png';

      console.log('PDF converted to PNG successfully. Base64 length:', imageData.length);

      // Clean up temp files
      fs.unlinkSync(tempPdfPath);
      fs.unlinkSync(pngFilePath);
    }

    // --- Gemini model setup ---
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

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
4. Ensure dates are in YYYY-MM-DD format.
5. Extract only the invoice details, nothing else.`;

    const imagePart = {
      inlineData: {
        data: imageData,
        mimeType: mimeType
      }
    };

    // --- Retry logic ---
    let result;
    const maxRetries = 3;
    let retries = 0;

    while (retries < maxRetries) {
      try {
        result = await model.generateContent({
          contents: [{
            parts: [
              { text: prompt },
              imagePart
            ]
          }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                "invoiceNumber": { "type": "STRING", "nullable": true },
                "vendorName": { "type": "STRING", "nullable": true },
                "invoiceDate": { "type": "STRING", "nullable": true },
                "dueDate": { "type": "STRING", "nullable": true },
                "totalAmount": { "type": "NUMBER", "nullable": true },
                "currency": { "type": "STRING", "nullable": true },
                "lineItems": {
                  "type": "ARRAY",
                  "items": {
                    "type": "OBJECT",
                    "properties": {
                      "product": { "type": "STRING", "nullable": true },
                      "quantity": { "type": "NUMBER", "nullable": true },
                      "unitPrice": { "type": "NUMBER", "nullable": true },
                      "totalPrice": { "type": "NUMBER", "nullable": true }
                    }
                  }
                }
              }
            }
          }
        });

        if (result?.candidates?.[0]?.content?.parts?.[0]?.text) break;
      } catch (error) {
        console.error(`AI call failed (Retry ${retries + 1}/${maxRetries}):`, error.message);
      }
      retries++;
      if (retries < maxRetries) {
        const delay = Math.pow(2, retries) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    const extractedDataPart = result?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!extractedDataPart) {
      console.error('Final attempt failed. Unexpected AI response:', JSON.stringify(result, null, 2));
      return response.status(500).json({
        error: 'Failed to process AI response.',
        details: 'The AI model returned an unexpected or empty response after multiple retries.'
      });
    }

    try {
      const extractedData = JSON.parse(extractedDataPart);
      return response.status(200).json(extractedData);
    } catch (parseError) {
      console.error('JSON parsing error after AI response:', parseError);
      return response.status(500).json({
        error: 'Failed to parse AI response.',
        details: 'The AI returned a response that could not be parsed as valid JSON.'
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
