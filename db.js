const mysql = require('mysql2/promise')
require('dotenv').config();


const pool = mysql.createPool({
    host : process.env.DB_HOST,
    port : Number(process.env.DB_PORT || 3306),
    user : process.env.DB_USER,
    password : process.env.DB_PASS,
    database : process.env.DB_NAME,
    waitForConnections : true,
    connectionLimit : 10,
    queueLimit : 0,
    namedPlaceholders : true,
    /* TiDB Cloud บังคับต่อแบบ TLS → ตั้ง DB_SSL=true ตอน deploy (MySQL ในเครื่องไม่ต้องตั้ง) */
    ssl : process.env.DB_SSL === 'true'
        ? { minVersion : 'TLSv1.2', rejectUnauthorized : true }
        : undefined
})


async function query(sql,params) {
    const [rows] = await pool.execute(sql,params);
    return rows;
}

async function waitForConnections(fn) {
    const conn = await pool.getConnection();
    try{
        await conn.beginTransaction();
        const result = await fn(conn);
        return result;
    }catch(err){
        await conn.rollback();
        throw err;
    }finally{
        conn.release();
    }
    
}

module.exports = {pool, query, waitForConnections}
