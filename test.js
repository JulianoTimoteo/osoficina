const https = require('https');

const agent = new https.Agent({ rejectUnauthorized: false });

https.get('https://simplefarm.usinapitangueiras.com.br:8050/Login', { agent }, (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    console.log("Headers:", res.headers);
    const tokenMatch = data.match(/name="__RequestVerificationToken" type="hidden" value="([^"]+)"/);
    if(tokenMatch) {
      console.log("Found token:", tokenMatch[1]);
    } else {
      console.log("No token found");
    }
  });
});
