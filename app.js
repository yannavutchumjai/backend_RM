const express = require('express');
const cors = require('cors');
require('dotenv').config();
const path = require('path');

const app = express();
/* โดเมนหน้าเว็บที่อนุญาต อ่านจาก CORS_ORIGIN ใน .env (หลายโดเมนคั่นด้วย ,) */
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

app.use(express.json());

/* บันทึกทุกคำขอที่เปลี่ยนข้อมูล (POST/PUT/DELETE) ลง activity_logs อัตโนมัติ
   ต้องอยู่ก่อน app.use ของ route ทั้งหมด */
const { activityLogger } = require('./lib/activityLog');
app.use(activityLogger);

app.use("/uploads", express.static("uploads"));
//app.use('/uploads',express.static(path.join(__dirname,'uploads')));

app.use('/static', express.static(path.join(__dirname, 'static')));

const authRoutes = require('./routes/auth.routes')
const productRoutes = require('./routes/product.routes')
const colorRoutes = require('./routes/color.routes')
const employeeRoutes = require('./routes/employee.routes');
const fabricRoutes = require('./routes/fabric.routes');
const billRoutes = require('./routes/bill.routes');
const fabricrollsRoutes = require('./routes/fabricrolls.routes');
const DetailbillRoutes = require('./routes/Detailbill.routes');
const fabrictypesRoutes = require('./routes/fabrictypes.routes');
const fabricusageRoutes = require('./routes/fabricusage.routes');
const paymentRoutes = require('./routes/payment.routes');
const promotionRoutes = require('./routes/promotion.routes');
const sizesRoutes = require('./routes/sizes.routes');
const suppliersRoutes = require('./routes/suppliers.routes');
const shopSettingsRoutes = require('./routes/shop_settings.routes');
const geoRoutes = require('./routes/geo.routes');
const supplier_fabric_historyRoutes = require('./routes/supplier_fabric_history.routes');
const tokensRoutes = require('./routes/tokens.routes');
const usersRoutes = require('./routes/users.routes');
const activity_logsRoutes = require('./routes/activity_logs.routes');
const StockRoutes = require('./routes/Stock.routes');
const categoryRoutes = require('./routes/category.routes');
const purchaseOrdersRoutes = require('./routes/purchase_orders.routes');
const purchaseOrderItemsRoutes = require('./routes/purchase_order_items.routes');
const tailoringOrdersRoutes = require('./routes/tailoringorders.routes');
const fabricCalculatorRoutes = require('./routes/fabric-calculator.routes');
const outfitFormulaRoutes = require('./routes/outfit-formula.routes');
const productCategoryRoutes = require('./routes/product_category.routes');


// app.get('/',(req, res) => {
//     res.status(200).json({
//         message: "Hello Node.js",
//     });
// });

app.use('/auth',authRoutes)
app.use("/api/products", productRoutes);
app.use('/color',colorRoutes)
app.use('/employee', employeeRoutes); 
app.use('/fabric', fabricRoutes);
app.use('/bill', billRoutes);
app.use('/fabricrolls', fabricrollsRoutes);
app.use('/Detailbill', DetailbillRoutes);
app.use('/fabrictypes', fabrictypesRoutes);
app.use('/fabricusage', fabricusageRoutes);
app.use('/payment', paymentRoutes);
app.use('/promotion', promotionRoutes);
app.use('/sizes', sizesRoutes);
app.use('/suppliers', suppliersRoutes);
app.use('/shop_settings', shopSettingsRoutes);
app.use('/geo', geoRoutes);
app.use('/supplier_fabric_history', supplier_fabric_historyRoutes);
app.use('/tokens', tokensRoutes);
app.use('/users', usersRoutes);
app.use('/activity_logs', activity_logsRoutes);
app.use('/Stock', StockRoutes);
app.use('/category', categoryRoutes);
app.use('/purchase_orders', purchaseOrdersRoutes);
app.use('/purchase_order_items', purchaseOrderItemsRoutes);
app.use('/tailoringorders', tailoringOrdersRoutes);
app.use('/api/fabric-calculator', fabricCalculatorRoutes);
app.use('/api/outfit-formulas', outfitFormulaRoutes);
app.use('/product-categories', productCategoryRoutes);

//404 ไม่พบหน้า
app.use((req, res) => {
    res.status(404).json({
        message: "Route Not Found",
    });
});

// start Server
const PORT = Number(process.env.PORT || 3010);
app.listen(PORT, () => {
    console.log(`API Running port http://127.0.0.1:${PORT}`);
});
