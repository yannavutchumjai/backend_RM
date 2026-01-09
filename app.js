const express = require('express');
require('dotenv').config();
const path = require('path');

const app = express();
app.use(express.json());

app.use('/uploads',express.static(path.join(__dirname,'uploads')));

const authRoutes = require('./routes/auth.routes')
const productRoutes = require('./routes/product.routes')
const colorRoutes = require('./routes/color.routes.js')
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
const supplier_fabric_historyRoutes = require('./routes/supplier_fabric_history.routes');
const tokensRoutes = require('./routes/tokens.routes');
const usersRoutes = require('./routes/users.routes');
const activity_logsRoutes = require('./routes/activity_logs.routes');

// app.get('/',(req, res) => {
//     res.status(200).json({
//         message: "Hello Node.js",
//     });
// });

app.use('/auth',authRoutes)
app.use('/products',productRoutes)
app.use('/colors',colorRoutes)
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
app.use('/supplier_fabric_history', supplier_fabric_historyRoutes);
app.use('/tokens', tokensRoutes);
app.use('/users', usersRoutes);
app.use('/activity_logs', activity_logsRoutes);

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