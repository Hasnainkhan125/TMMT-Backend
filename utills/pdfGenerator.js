const { jsPDF } = require("jspdf"); // will automatically load the node version

require('jspdf-autotable');
const path = require('path');
const fs = require('fs');

// Load logo
const logoPath = path.join(__dirname, './logo_purple_blackTeam.png');
const logoBase64 = fs.readFileSync(logoPath, { encoding: 'base64' });

// Common styling
const styles = {
  header: {
    fontSize: 24,
    fontStyle: 'bold',
    textColor: [0, 0, 0],
  },
  subheader: {
    fontSize: 14,
    fontStyle: 'bold',
    textColor: [80, 80, 80],
  },
  normal: {
    fontSize: 10,
    fontStyle: 'normal',
    textColor: [0, 0, 0],
  },
  small: {
    fontSize: 8,
    fontStyle: 'normal',
    textColor: [100, 100, 100],
  },
};

// Helper function to format currency
const formatCurrency = (amount) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
};

// Helper function to format date
const formatDate = (date) => {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(date));
};

// Generate Quotation PDF
exports.generateQuotationPDF = async (quotation) => {
  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4'
  });
  const pageWidth = doc.internal.pageSize.width;
  const pageHeight = doc.internal.pageSize.height;

  // Add header with logo and company name
  doc.addImage(logoBase64, 'PNG', 10, 10, 40, 40);
  doc.setFontSize(styles.header.fontSize);
  doc.setFont('helvetica', styles.header.fontStyle);
  doc.text('QUOTATION', pageWidth - 10, 25, { align: 'right' });

  // Add quotation details
  doc.setFontSize(styles.normal.fontSize);
  doc.setFont('helvetica', styles.normal.fontStyle);
  
  // Quotation info box
  doc.rect(pageWidth - 90, 40, 80, 35);
  doc.text([
    `Quotation #: ${quotation.quotationNumber}`,
    `Date: ${formatDate(quotation.date)}`,
    `Valid Until: ${formatDate(quotation.expiryDate)}`,
  ], pageWidth - 85, 45);

  // Customer info
  doc.setFontSize(styles.subheader.fontSize);
  doc.text('Customer Information', 10, 70);
  doc.setFontSize(styles.normal.fontSize);
  doc.text([
    `Name: ${quotation.customerName}`,
    `Email: ${quotation.customerEmail}`,
    `Phone: ${quotation.customerPhone}`,
    `Address: ${quotation.customerAddress || 'N/A'}`,
  ], 10, 80);

  // Vehicle info
  doc.setFontSize(styles.subheader.fontSize);
  doc.text('Vehicle Information', 10, 110);
  doc.setFontSize(styles.normal.fontSize);
  doc.text([
    `Make: ${quotation.vehicleMake}`,
    `Model: ${quotation.vehicleModel}`,
    `Year: ${quotation.vehicleYear}`,
    `VIN: ${quotation.vehicleVin}`,
    `Mileage: ${quotation.vehicleMileage?.toLocaleString() || 'N/A'} km`,
  ], 10, 120);

  // Items table
  const tableHeaders = [['Description', 'Quantity', 'Unit Price', 'Discount', 'Total']];
  const tableData = quotation.items.map(item => [
    item.description,
    item.quantity,
    formatCurrency(item.unitPrice),
    `${item.discount}%`,
    formatCurrency(item.quantity * item.unitPrice * (1 - item.discount / 100)),
  ]);

  doc.autoTable({
    startY: 150,
    head: tableHeaders,
    body: tableData,
    theme: 'grid',
    headStyles: {
      fillColor: [85, 85, 85],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
    },
    styles: {
      fontSize: 9,
      cellPadding: 5,
    },
  });

  // Totals
  const finalY = doc.lastAutoTable.finalY + 10;
  doc.setFontSize(styles.normal.fontSize);
  doc.text([
    `Subtotal: ${formatCurrency(quotation.subtotal)}`,
    `Tax (${quotation.taxRate}%): ${formatCurrency(quotation.taxAmount)}`,
    `Total Amount: ${formatCurrency(quotation.totalAmount)}`,
  ], pageWidth - 60, finalY, { align: 'right' });

  // Notes
  if (quotation.notes) {
    doc.setFontSize(styles.subheader.fontSize);
    doc.text('Notes', 10, finalY + 30);
    doc.setFontSize(styles.normal.fontSize);
    doc.text(quotation.notes, 10, finalY + 40, {
      maxWidth: pageWidth - 20,
    });
  }

  // Footer
  doc.setFontSize(styles.small.fontSize);
  doc.setTextColor(...styles.small.textColor);
  doc.text('BlackTeam Automobile - Your Trusted Automotive Partner', pageWidth / 2, pageHeight - 20, {
    align: 'center',
  });
  return doc.output('arraybuffer');
};

// Generate Sales Order PDF
exports.generateSalesOrderPDF = async (salesOrder) => {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4'
  });
  const pageWidth = doc.internal.pageSize.width;
  const pageHeight = doc.internal.pageSize.height;
  const margin = 10;

  // Add header with logo and company name
  doc.addImage(logoBase64, 'PNG', margin, margin, 40, 40);
  doc.setFontSize(styles.header.fontSize);
  doc.setFont('helvetica', styles.header.fontStyle);
  doc.text('SALES ORDER', pageWidth - margin, 25, { align: 'right' });

  // Add sales order details
  doc.setFontSize(styles.normal.fontSize);
  doc.setFont('helvetica', styles.normal.fontStyle);
  
  // Sales order info box
  doc.rect(pageWidth - 90, 40, 80, 45);
  doc.text([
    `Order #: ${salesOrder.orderNumber}`,
    `Date: ${formatDate(salesOrder.date)}`,
    `Status: ${salesOrder.status}`,
    `Quotation #: ${salesOrder.quotationId?.quotationNumber || 'N/A'}`,
  ], pageWidth - 85, 45);

  // Customer info
  doc.setFontSize(styles.subheader.fontSize);
  doc.text('Customer Information', margin, 70);
  doc.setFontSize(styles.normal.fontSize);
  doc.text([
    `Name: ${salesOrder.customerName}`,
    `Email: ${salesOrder.customerEmail}`,
    `Phone: ${salesOrder.customerPhone}`,
    `Address: ${salesOrder.customerAddress}`,
  ], margin, 80);

  // Vehicle info
  doc.setFontSize(styles.subheader.fontSize);
  doc.text('Vehicle Information', margin, 110);
  doc.setFontSize(styles.normal.fontSize);
  doc.text([
    `Make: ${salesOrder.vehicleInfo.make}`,
    `Model: ${salesOrder.vehicleInfo.model}`,
    `Year: ${salesOrder.vehicleInfo.year}`,
    `VIN: ${salesOrder.vehicleInfo.vin}`,
    `Mileage: ${salesOrder.vehicleInfo.mileage?.toLocaleString()} km`,
  ], margin, 120);

  // Items table
  const tableHeaders = [['Description', 'Part Number', 'Quantity', 'Unit Price', 'Discount', 'Total']];
  const tableData = salesOrder.items.map(item => [
    item.description,
    item.partNumber || 'N/A',
    item.quantity,
    formatCurrency(item.unitPrice),
    `${item.discount}%`,
    formatCurrency(item.quantity * item.unitPrice * (1 - item.discount / 100)),
  ]);

  doc.autoTable({
    startY: 150,
    head: tableHeaders,
    body: tableData,
    theme: 'grid',
    headStyles: {
      fillColor: [85, 85, 85],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
    },
    styles: {
      fontSize: 9,
      cellPadding: 5,
    },
  });

  // Payment and Totals
  const finalY = doc.lastAutoTable.finalY + 10;
  doc.setFontSize(styles.subheader.fontSize);
  doc.text('Payment Information', margin, finalY);
  doc.setFontSize(styles.normal.fontSize);
  doc.text([
    `Method: ${salesOrder.payment.method}`,
    `Status: ${salesOrder.payment.status}`,
    `Terms: ${salesOrder.payment.terms || 'N/A'}`,
  ], margin, finalY + 10);

  doc.text([
    `Subtotal: ${formatCurrency(salesOrder.pricing.subtotal)}`,
    `Tax (${salesOrder.pricing.taxRate}%): ${formatCurrency(salesOrder.pricing.taxAmount)}`,
    `Total Amount: ${formatCurrency(salesOrder.pricing.totalAmount)}`,
    `Amount Paid: ${formatCurrency(salesOrder.pricing.deposit?.amount || 0)}`,
    `Balance Due: ${formatCurrency(salesOrder.pricing.totalAmount - (salesOrder.pricing.deposit?.amount || 0))}`,
  ], pageWidth - 60, finalY + 10, { align: 'right' });

  // Delivery Information
  if (salesOrder.delivery) {
    doc.setFontSize(styles.subheader.fontSize);
    doc.text('Delivery Information', margin, finalY + 40);
    doc.setFontSize(styles.normal.fontSize);
    doc.text([
      `Status: ${salesOrder.delivery.status}`,
      `Estimated Date: ${salesOrder.delivery.estimatedDate ? formatDate(salesOrder.delivery.estimatedDate) : 'N/A'}`,
      `Address: ${salesOrder.delivery.address || 'N/A'}`,
      `Instructions: ${salesOrder.delivery.instructions || 'N/A'}`,
    ], margin, finalY + 50);
  }

  // Notes
  if (salesOrder.notes?.external) {
    doc.setFontSize(styles.subheader.fontSize);
    doc.text('Notes', margin, finalY + 80);
    doc.setFontSize(styles.normal.fontSize);
    doc.text(salesOrder.notes.external, margin, finalY + 90, {
      maxWidth: pageWidth - (margin * 2),
    });
  }

  // Footer
  doc.setFontSize(styles.small.fontSize);
  doc.setTextColor(...styles.small.textColor);
  doc.text([
    'BlackTeam Automobile - Your Trusted Automotive Partner',
    'Thank you for your business!',
    'For any inquiries, please contact us at support@blackteam.com',
  ], pageWidth / 2, pageHeight - 20, {
    align: 'center',
  });

  // Add page numbers
  const totalPages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.text(`Page ${i} of ${totalPages}`, pageWidth - margin, pageHeight - margin, {
      align: 'right',
    });
  }

  return doc.output('arraybuffer');
};

// Generate Invoice PDF
exports.generateInvoicePDF = async (invoice) => {
  try {
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4'
    });

    const pageWidth = doc.internal.pageSize.width;
    const pageHeight = doc.internal.pageSize.height;
    const margin = 20;

    // Load and add logo
    // const logoPath = path.join(__dirname, './logo_purple_blackTeam.png');
    // const logoBase64 = fs.readFileSync(logoPath, { encoding: 'base64' });
    // doc.addImage(logoBase64, 'PNG', margin, margin, 30, 30);

    // Company Information - Top Right
    doc.setFontSize(16);
    doc.setTextColor(51, 51, 51);
    doc.setFont("helvetica", "bold");
    doc.text("BlackTeam Automobile", pageWidth - margin, 25, { align: "right" });
    
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text([
      "14B, Northern Street",
      "Greater South Avenue",
      "New York 10001",
      "U.S.A"
    ], pageWidth - margin, 35, { align: "right" });

    // PROFORMA INVOICE Title
    doc.setFontSize(24);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(184, 86, 10); // Brown color like in the image
    doc.text("PROFORMA INVOICE", pageWidth / 2, 60, { align: "center" });

    // Bill To Section
    doc.setFontSize(12);
    doc.setTextColor(51, 51, 51);
    doc.setFont("helvetica", "bold");
    doc.text("Bill To", margin, 80);
    
    doc.setFont("helvetica", "bold");
    doc.setTextColor(184, 86, 10);
    doc.text(invoice.customer.name, margin, 90);
    
    doc.setFont("helvetica", "normal");
    doc.setTextColor(51, 51, 51);
    doc.text([
      invoice.customer.address,
      invoice.vehicleInfo.make + ", " + invoice.vehicleInfo.model,
      invoice.customer.email
    ], margin, 100);

    // Invoice Details Table - Top Right
    const invoiceDetailsX = pageWidth - 80;
    const invoiceDetailsWidth = 60;
    
    // Draw table for invoice details
    doc.setDrawColor(184, 86, 10);
    doc.setFillColor(184, 86, 10);
    
    // Headers with brown background
    const invoiceDetails = [
      { label: "Invoice#", value: invoice.invoiceNumber },
      { label: "Invoice Date", value: new Date(invoice.date).toLocaleDateString() },
      { label: "Terms", value: invoice.payment.terms || "Due on Receipt" },
      { label: "Due Date", value: new Date(invoice.dueDate).toLocaleDateString() }
    ];

    invoiceDetails.forEach((detail, index) => {
      // Header cell
      doc.setFillColor(184, 86, 10);
      doc.rect(invoiceDetailsX, 80 + (index * 10), invoiceDetailsWidth/2, 8, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont("helvetica", "bold");
      doc.text(detail.label, invoiceDetailsX + 2, 85 + (index * 10));
      
      // Value cell
      doc.setFillColor(255, 255, 255);
      doc.rect(invoiceDetailsX + invoiceDetailsWidth/2, 80 + (index * 10), invoiceDetailsWidth/2, 8, 'F');
      doc.setTextColor(51, 51, 51);
      doc.setFont("helvetica", "normal");
      doc.text(detail.value, invoiceDetailsX + invoiceDetailsWidth/2 + 2, 85 + (index * 10));
    });

    // Items Table
    const tableTop = 130;
    const tableHeaders = [
      { header: "#", width: 10 },
      { header: "Item & Description", width: 80 },
      { header: "Qty", width: 20 },
      { header: "Rate", width: 30 },
      { header: "Amount", width: 30 }
    ];

    // Draw table header
    doc.setFillColor(184, 86, 10);
    let currentX = margin;
    tableHeaders.forEach(col => {
      doc.rect(currentX, tableTop, col.width, 10, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont("helvetica", "bold");
      doc.text(col.header, currentX + 2, tableTop + 7);
      currentX += col.width;
    });

    // Draw table rows
    let currentY = tableTop + 10;
    invoice.items.forEach((item, index) => {
      const row = [
        (index + 1).toString(),
        {
          title: item.description,
          subtitle: item.partNumber || ""
        },
        item.quantity.toString(),
        "$" + item.unitPrice.toFixed(2),
        "$" + item.subtotal.toFixed(2)
      ];

      // Alternate row background
      if (index % 2 === 0) {
        doc.setFillColor(245, 245, 245);
        doc.rect(margin, currentY, currentX - margin, 15, 'F');
      }

      // Draw row content
      let x = margin;
      row.forEach((cell, cellIndex) => {
        doc.setTextColor(51, 51, 51);
        if (typeof cell === 'object') {
          // For items with title and subtitle
          doc.setFont("helvetica", "normal");
          doc.text(cell.title, x + 2, currentY + 5);
          doc.setFontSize(8);
          doc.text(cell.subtitle, x + 2, currentY + 10);
          doc.setFontSize(10);
        } else {
          doc.text(cell, x + 2, currentY + 8);
        }
        x += tableHeaders[cellIndex].width;
      });
      currentY += 15;
    });

    // Totals section
    const totalsStartX = pageWidth - 80;
    currentY += 10;
    
    const totalsData = [
      { label: "Sub Total", value: "$" + invoice.pricing.subtotal.toFixed(2) },
      { label: "Tax Rate", value: invoice.pricing.taxRate + "%" },
      { label: "Total", value: "$" + invoice.pricing.totalAmount.toFixed(2) }
    ];

    totalsData.forEach((row, index) => {
      doc.setFont("helvetica", "bold");
      doc.text(row.label, totalsStartX, currentY + (index * 8));
      doc.setFont("helvetica", "normal");
      doc.text(row.value, pageWidth - margin, currentY + (index * 8), { align: "right" });
    });

    // Balance Due
    currentY += 35;
    doc.setFillColor(184, 86, 10);
    doc.rect(totalsStartX - 20, currentY - 5, pageWidth - totalsStartX + margin, 12, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.text("Balance Due", totalsStartX - 18, currentY + 2);
    doc.text("$" + invoice.pricing.totalAmount.toFixed(2), pageWidth - margin, currentY + 2, { align: "right" });

    // Terms and Conditions
    currentY += 20;
    doc.setTextColor(51, 51, 51);
    doc.setFont("helvetica", "bold");
    doc.text("Terms & Conditions", margin, currentY);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const terms = invoice.notes?.external || "All payments must be made in full before the commencement of any work.";
    doc.text(terms, margin, currentY + 8, {
      maxWidth: pageWidth - (margin * 2)
    });

    // Footer
    doc.setFontSize(8);
    doc.setTextColor(128, 128, 128);
    doc.text("Thank you for your business!", pageWidth / 2, pageHeight - 20, { align: "center" });

    // Save PDF
    const pdfPath = path.join(__dirname, '../uploads/invoices', `invoice-${invoice.invoiceNumber}.pdf`);
    doc.save(pdfPath);

    return pdfPath;
  } catch (error) {
    console.error("Failed to generate invoice PDF:", error);
    throw error;
  }
}; 