/** NYSE regular auction, America/New_York. Prices still define actual trading days. */
export function usSessionCloseUtc(ymd:string): number {
  const year=Number(ymd.slice(0,4));
  const noon=Date.parse(`${ymd}T12:00:00Z`);
  if(!Number.isFinite(noon))return NaN;
  const nyHour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(noon));
  const utcOffsetHours=12-nyHour;
  const thanksgiving=new Date(Date.UTC(year,10,1));
  const fourthThursday=1+(4-thanksgiving.getUTCDay()+7)%7+21;
  const nextThanksgivingDay=`${year}-11-${String(fourthThursday+1).padStart(2,'0')}`;
  const weekday=new Date(noon).getUTCDay();
  // Published equity early closes: day after Thanksgiving, weekday Christmas Eve,
  // July 3 when July 4 is Tuesday–Friday. July 3 Friday is the observed holiday.
  const july4=new Date(Date.UTC(year,6,4)).getUTCDay();
  const early=ymd===nextThanksgivingDay || ymd===`${year}-12-24`&&weekday>=1&&weekday<=4 || ymd===`${year}-07-03`&&july4>=2&&july4<=5;
  return Date.parse(`${ymd}T00:00:00Z`)+(early?13:16)*3600000+utcOffsetHours*3600000;
}
