// /api/extract-invoice.js
// This file should be in your /api directory for Vercel deployment

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { image } = req.body;

    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }

    // Get Gemini API key from environment variables
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('Gemini API key not found in environment variables');
      return res.status(500).json({ error: 'API key not configured' });
    }

    // Call Google Gemini Vision API
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: 'Extract the following information from this invoice/receipt image and return it as valid JSON only (no markdown formatting, no additional text): invoiceNumber, vendorName, invoiceDate, dueDate, totalAmount (as number), currency, taxAmount (as number), subtotal (as number), and lineItems (array of objects with: product, quantity (as number), unitPrice (as number), totalPrice (as number)). If any field is not found, use null.'
              },
              {
                inline_data: {
                  mime_type: 'image/jpeg',
                  data: image
                }
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1000,
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gemini API error:', response.status, errorText);
      return res.status(500).json({ error: `Gemini API error: ${response.status}` });
    }

    const data = await response.json();
    
    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content || !data.candidates[0].content.parts) {
      console.error('Invalid Gemini response structure:', data);
      return res.status(500).json({ error: 'Invalid API response structure' });
    }

    let extractedText = data.candidates[0].content.parts[0].text.trim();
    
    // Clean up the response - remove markdown formatting if present
    extractedText = extractedText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    
    try {
      const extractedData = JSON.parse(extractedText);
      console.log('Successfully extracted data:', extractedData);
      return res.status(200).json(extractedData);
    } catch (parseError) {
      console.error('Failed to parse Gemini response as JSON:', extractedText);
      return res.status(500).json({ error: 'Failed to parse extracted data' });
    }

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
