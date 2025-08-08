const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const { Parser } = require('json2csv');
const ExcelJS = require('exceljs');
const { google } = require('googleapis');

module.exports = async (req, res) => {
  // CORS and method checks (same as before)
  // ...

  try {
    // Parse JSON body expecting array of PDFs
    let rawBody = '';
    for await (const chunk of req) rawBody += chunk;
    const parsedBody = JSON.parse(rawBody);
    const files = parsedBody.files; // expecting: [{ imageData, mimeType }, ...]

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'No files provided or invalid format.' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API key missing.' });

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

    const extractedInvoices = [];

    // Process all PDFs in parallel with Promise.all
    await Promise.all(files.map(async ({ imageData, mimeType }) => {
      if (mimeType !== 'application/pdf') {
        throw new Error('Only PDFs are supported.');
      }

      // Convert first page PDF -> PNG
      const pdfBytes = Buffer.from(imageData, 'base64');
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const singlePagePdf = await PDFDocument.create();
      const [copiedPage] = await singlePagePdf.copyPages(pdfDoc, [0]);
      singlePagePdf.addPage(copiedPage);
      const singlePagePdfBytes = await singlePagePdf.save();

      const pngBuffer = await sharp(Buffer.from(singlePagePdfBytes))
        .png()
        .resize({ width: 1200 }) // adjust resolution as needed
        .toBuffer();

      const pngBase64 = pngBuffer.toString('base64');

      // Prepare prompt + image for Gemini
      const imagePart = {
        inlineData: {
          data: pngBase64,
          mimeType: 'image/png'
        }
      };

      // AI call with retries (simplified for brevity)
      let aiResponse;
      let retries = 0;
      const maxRetries = 3;
      while (retries < maxRetries) {
        try {
          const result = await model.generateContent({
            contents: [{ parts: [{ text: prompt }, imagePart] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: {
                type: "OBJECT",
                properties: {
                  invoiceNumber: { type: "STRING", nullable: true },
                  vendorName: { type: "STRING", nullable: true },
                  invoiceDate: { type: "STRING", nullable: true },
                  dueDate: { type: "STRING", nullable: true },
                  totalAmount: { type: "NUMBER", nullable: true },
                  currency: { type: "STRING", nullable: true },
                  lineItems: {
                    type: "ARRAY",
                    items: {
                      type: "OBJECT",
                      properties: {
                        product: { type: "STRING", nullable: true },
                        quantity: { type: "NUMBER", nullable: true },
                        unitPrice: { type: "NUMBER", nullable: true },
                        totalPrice: { type: "NUMBER", nullable: true }
                      }
                    }
                  }
                }
              }
            }
          });

          const extractedText = result?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (extractedText) {
            aiResponse = JSON.parse(extractedText);
            break;
          }
        } catch (e) {
          retries++;
          await new Promise(r => setTimeout(r, 2 ** retries * 1000));
        }
      }

      if (!aiResponse) throw new Error('AI extraction failed after retries.');

      extractedInvoices.push(aiResponse);
    }));

    // --- Convert extractedInvoices array to CSV and Excel ---

    // Flatten line items for CSV: one line per item + invoice info
    const csvRecords = [];
    extractedInvoices.forEach(inv => {
      if (inv.lineItems && inv.lineItems.length > 0) {
        inv.lineItems.forEach(item => {
          csvRecords.push({
            invoiceNumber: inv.invoiceNumber,
            vendorName: inv.vendorName,
            invoiceDate: inv.invoiceDate,
            dueDate: inv.dueDate,
            totalAmount: inv.totalAmount,
            currency: inv.currency,
            product: item.product,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            totalPrice: item.totalPrice
          });
        });
      } else {
        csvRecords.push({
          invoiceNumber: inv.invoiceNumber,
          vendorName: inv.vendorName,
          invoiceDate: inv.invoiceDate,
          dueDate: inv.dueDate,
          totalAmount: inv.totalAmount,
          currency: inv.currency,
          product: null,
          quantity: null,
          unitPrice: null,
          totalPrice: null
        });
      }
    });

    // CSV conversion
    const json2csvParser = new Parser();
    const csvData = json2csvParser.parse(csvRecords);

    // Excel conversion using ExcelJS
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Invoices');

    worksheet.columns = Object.keys(csvRecords[0] || {}).map(key => ({ header: key, key }));
    csvRecords.forEach(record => worksheet.addRow(record));

    const excelBuffer = await workbook.xlsx.writeBuffer();

    // TODO: Upload to Google Sheets (requires auth setup)
    // Here is a simplified example outline:
    /*
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    await sheets.spreadsheets.values.update({
      spreadsheetId: 'your-sheet-id',
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      resource: { values: csvRecords.map(r => Object.values(r)) }
    });
    */

    // Respond with CSV and Excel buffers base64 encoded (or save & provide links)
    res.status(200).json({
      invoices: extractedInvoices,
      csv: Buffer.from(csvData).toString('base64'),
      excel: excelBuffer.toString('base64')
    });

  } catch (err) {
    console.error('Error processing invoices:', err);
    res.status(500).json({ error: err.message });
  }
};
