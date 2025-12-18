const useragent = require("useragent");
const URL = require("node:url");

const WebServiceClient = require('@maxmind/geoip2-node').WebServiceClient;
const { removeWww } = require("../utils");
const query = require("../queries");
const { config } = require("dotenv");
config()

const geoip2LiteClient = new WebServiceClient(process.env.MAXMIND_USERID, process.env.MAXMIND_LICENSE_KEY,{host: 'geolite.info'});
const browsersList = ["IE", "Firefox", "Chrome", "Opera", "Safari", "Edge"];
const osList = ["Windows", "Mac OS", "Linux", "Android", "iOS"];

function filterInBrowser(agent) {
  return function(item) {
    return agent.family.toLowerCase().includes(item.toLocaleLowerCase());
  }
}

function filterInOs(agent) {
  return function(item) {
    return agent.os.family.toLowerCase().includes(item.toLocaleLowerCase());
  }
}

module.exports = async function({ data }) {
  const tasks = [];
  
  tasks.push(query.link.incrementVisit({ id:  data.link.id }));
  
  // the following line is for backward compatibility
  // used to send the whole header to get the user agent
  const userAgent = data.userAgent || data.headers?.["user-agent"];
  const agent = useragent.parse(userAgent);
  const [browser = "Other"] = browsersList.filter(filterInBrowser(agent));
  const [os = "Other"] = osList.filter(filterInOs(agent));
  const referrer =
  data.referrer && removeWww(URL.parse(data.referrer).hostname);

const maxmindResponse = await geoip2LiteClient.city(data.ip)
console.log(JSON.stringify({maxmindResponse},null,2))
const countryIso = maxmindResponse.country.isoCode
const state = maxmindResponse.subdivisions?.length && maxmindResponse.subdivisions[0]?.names["en"]
const city = maxmindResponse.city?.names["en"]
  tasks.push(
    query.visit.add({
      browser: browser.toLowerCase(),
      country: countryIso || "Unknown",
      link_id: data.link.id,
      user_id: data.link.user_id,
      os: os.toLowerCase().replace(/\s/gi, ""),
      referrer: (referrer && referrer.replace(/\./gi, "[dot]")) || "Direct",
      city:  (countryIso == "IN" && city) || "Unknown",
      state: (countryIso == "IN" && state) || "Unknown",
      
    })
  );

  return Promise.all(tasks);
}