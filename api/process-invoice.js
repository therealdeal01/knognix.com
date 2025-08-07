const { GoogleGenerativeAI } = require('@google/generative-ai');

module.exports = async (request, response) => {
  if (request.method !== 'POST') {
    return response.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return response.status(500).json({ error: 'API key is not configured.' });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-preview-05-20' });

    const { image } = request.body;
    const prompt = `Extract invoice information from this document. Return JSON with: invoiceNumber, vendorName, invoiceDate, dueDate, totalAmount, currency, taxAmount, subtotal, and lineItems (array with product, quantity, unitPrice, totalPrice).`;

    const payload = {
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: 'image/jpeg',
              data: image,
            },
          },
        ],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            invoiceNumber: { type: 'STRING' },
            vendorName: { type: 'STRING' },
            invoiceDate: { type: 'STRING' },
            dueDate: { type: 'STRING' },
            totalAmount: { type: 'NUMBER' },
            currency: { type: 'STRING' },
            taxAmount: { type: 'NUMBER' },
            subtotal: { type: 'NUMBER' },
            lineItems: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  product: { type: 'STRING' },
                  quantity: { type: 'INTEGER' },
                  unitPrice: { type: 'NUMBER' },
                  totalPrice: { type: 'NUMBER' },
                },
              },
            },
          },
        },
      },
    };

    const result = await model.generateContent(payload.contents, payload.generationConfig);
    const jsonString = result.candidates[0].content.parts[0].text;
    
    response.status(200).json(JSON.parse(jsonString));
  } catch (error) {
    console.error('Error in serverless function:', error);
    response.status(500).json({ error: 'Failed to process invoice.' });
  }
};

