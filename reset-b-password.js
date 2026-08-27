// reset-b-password.js
// Run: node reset-b-password.js
// Effect: reset k6-B 13800000001 password to Test@123456, force_change_pwd=0
const argon2 = require('argon2');
const { execSync } = require('child_process');

(async () => {
  const newPassword = 'Test@123456';
  const phone = '13800000001';
  const mysqlExe = 'C:\\mysql8\\bin\\mysql.exe';

  const hash = await argon2.hash(newPassword);
  console.log('[1/3] Generated hash:', hash.substring(0, 50) + '...');

  const escapedHash = hash.replace(/'/g, "\\'");
  const sqlUpdate = `UPDATE app_users SET password_hash='${escapedHash}', force_change_pwd=0, status='active' WHERE phone='${phone}';`;
  const updateOut = execSync(`"${mysqlExe}" -uroot -proot burnmsg -e "${sqlUpdate}"`, { encoding: 'utf8' });
  console.log('[2/3] UPDATE result:', (updateOut || '(empty = success)').trim());

  const verifyOut = execSync(
    `"${mysqlExe}" -uroot -proot burnmsg -e "SELECT phone, status, force_change_pwd, LEFT(password_hash, 30) AS hash30 FROM app_users WHERE phone='${phone}';"`,
    { encoding: 'utf8' }
  );
  console.log('[3/3] Verify:');
  console.log(verifyOut);

  console.log('\nDone. Now login with phone=13800000001 password=Test@123456');
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
