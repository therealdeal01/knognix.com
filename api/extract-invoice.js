const { GoogleGenerativeAI } = require('@google/generative-ai');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');

// --- Helper function for exponential backoff ---
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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

    // Get the array of files from the request body
    const { files } = request.body;
    
    // Validate the request body
    if (!files || !Array.isArray(files) || files.length === 0) {
      return response.status(400).json({ error: 'Missing or invalid file array in request body.' });
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
4. Ensure dates are in YYYY-MM-DD format.
5. Extract only the invoice details, nothing else.`;
    
    const extractedInvoices = [];

    // Process all files in parallel
    await Promise.all(files.map(async ({ imageData, mimeType }) => {
      let imagePart;
      
      try {
        if (mimeType.startsWith('image/')) {
          // Process JPG/PNG files directly
          imagePart = {
            inlineData: {
              data: imageData,
              mimeType: mimeType
            }
          };
        } else if (mimeType === 'application/pdf') {
          // Convert the first page of the PDF to a PNG image
          const pdfBytes = Buffer.from(imageData, 'base64');
          const pdfDoc = await PDFDocument.load(pdfBytes);
          
          if (pdfDoc.getPageCount() === 0) {
              throw new Error('PDF document has no pages.');
          }
          
          // Note: pdf-lib itself doesn't render to an image. The sharp library
          // cannot directly process a single-page PDF buffer created by pdf-lib.
          // This part of the code would need a more complex solution involving
          // a PDF rendering library like 'node-canvas' or a different approach
          // to be fully functional. For this reason, this PDF conversion logic
          // is a simplified placeholder.
          // The AI model can often process PDFs directly, so we'll pass the PDF data.
          imagePart = {
            inlineData: {
              data: imageData,
              mimeType: mimeType
            }
          };
          
          // Fallback to simpler PDF conversion if direct processing fails.
          // The previous code using 'sharp' with pdf-lib is an invalid approach.
          // The best solution is to pass the base64 PDF data directly to Gemini,
          // which the new code handles by skipping the sharp conversion.
        } else {
          throw new Error(`Unsupported file type: ${mimeType}`);
        }
      } catch (error) {
        console.error('File conversion error:', error);
        // Push a structured error to the results array
        extractedInvoices.push({ error: `File conversion failed: ${error.message}` });
        return; // Skip this file and move to the next one
      }

      // --- Call the AI with retry logic ---
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
          
          if (result?.candidates?.[0]?.content?.parts?.[0]?.text) {
            break;
          }
        } catch (error) {
          console.error(`AI call failed (Retry ${retries + 1}/${maxRetries}):`, error.message);
        }
        
        retries++;
        if (retries < maxRetries) {
          const delay = Math.pow(2, retries) * 1000;
          await sleep(delay);
        }
      }

      // Final check after retries
      const extractedDataPart = result?.candidates?.[0]?.content?.parts?.[0]?.text;
      
      if (!extractedDataPart) {
        console.error('Final AI attempt failed.');
        extractedInvoices.push({ error: 'AI extraction failed after multiple retries.' });
        return;
      }
      
      try {
        const extractedData = JSON.parse(extractedDataPart);
        extractedInvoices.push(extractedData);
      } catch (parseError) {
        console.error('JSON parsing error after AI response:', parseError);
        extractedInvoices.push({ error: 'AI returned a response that could not be parsed.' });
      }
    }));

    return response.status(200).json({ invoices: extractedInvoices });

  } catch (error) {
    console.error('Error in serverless function:', error);
    return response.status(500).json({
      error: 'Failed to process invoice.',
      details: error.message
    });
  }
};

