const pool = require('../config/db');
const { encryptText, decryptText } = require('./crypto');

exports.setCreds = async (businessId, { email, pass, cod_cli }) => {
  const pass_enc = encryptText(pass);
  const cod_enc  = encryptText(cod_cli);
  const q = `
    INSERT INTO maxi_credentials (business_id, email, pass_enc, cod_cli_enc)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (business_id) DO UPDATE
      SET email = EXCLUDED.email,
          pass_enc = EXCLUDED.pass_enc,
          cod_cli_enc = EXCLUDED.cod_cli_enc,
          updated_at = now()
    RETURNING id
  `;
  await pool.query(q, [businessId, email, pass_enc, cod_enc]);
};

exports.getCreds = async (businessId) => {
  const { rows } = await pool.query(
    'SELECT email, pass_enc, cod_cli_enc FROM maxi_credentials WHERE business_id = $1',
    [businessId]
  );
  if (!rows[0]) return null;
  return {
    email: rows[0].email,
    pass: decryptText(rows[0].pass_enc),
    cod_cli: decryptText(rows[0].cod_cli_enc),
  };
};

exports.hasCreds = async (businessId) => {
  const { rows } = await pool.query(
    'SELECT 1 FROM maxi_credentials WHERE business_id = $1',
    [businessId]
  );
  return !!rows[0];
};
