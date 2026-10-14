import { queryApi, setApiKey } from 'sec-api';

const apiKey = process.env.SEC_API_IO_API_KEY?.trim();
if (!apiKey) {
  throw new Error('Set SEC_API_IO_API_KEY in the environment before running this script.');
}

setApiKey(apiKey);
const filings = await queryApi.getFilings({
  query: 'ticker:AAPL AND formType:"10-K"',
  from: '0',
  size: '5',
  sort: [{ filedAt: { order: 'desc' } }]
});

for (const filing of filings.filings ?? []) {
  console.log(filing.filedAt, filing.formType, filing.companyName);
}