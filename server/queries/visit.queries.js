const { isAfter, subDays, subHours, set, format } = require("date-fns");

const utils = require("../utils");
const redis = require("../redis");
const knex = require("../knex");
const env = require("../env");

async function add(params) {
  const data = {
    ...params,
    country: params.country.toLowerCase(),
    referrer: params.referrer.toLowerCase(),
    state: params.state.toLowerCase(),
    city: params.city.toLowerCase()
  };

  const nowUTC = new Date().toISOString();
  const truncatedNow = nowUTC.substring(0, 10) + " " + nowUTC.substring(11, 14) + "00:00";

  return knex.transaction(async (trx) => {
    // Create a subquery first that truncates the
    const subquery = trx("visits")
      .select("visits.*")
      .select({
        created_at_hours: utils.knexUtils(trx).truncatedTimestamp("created_at", "hour")
      })
      .where({ link_id: data.link_id })
      .as("subquery");

    const visit = await trx
      .select("*")
      .from(subquery)
      .where("created_at_hours", "=", truncatedNow)
      .forUpdate()
      .first();
      
    if (visit) {
      const countries = typeof visit.countries === "string" ? JSON.parse(visit.countries) : visit.countries;
      const referrers = typeof visit.referrers === "string" ? JSON.parse(visit.referrers) : visit.referrers;
      const states = typeof visit.states === "string" ? JSON.parse(visit.states) : visit.states;
      const cities = typeof visit.cities === "string" ? JSON.parse(visit.cities) : visit.cities;
      await trx("visits")
        .where({ id: visit.id })
        .increment(`br_${data.browser}`, 1)
        .increment(`os_${data.os}`, 1)
        .increment("total", 1)
        .update({
          updated_at: utils.dateToUTC(new Date()),
          countries: JSON.stringify({
            ...countries,
            [data.country]: (countries[data.country] ?? 0) + 1
          }),
          referrers: JSON.stringify({
            ...referrers,
             [data.referrer]: (referrers[data.referrer] ?? 0) + 1
          }),
          states: JSON.stringify({
            ...states,
            [data.state]: (states[data.state] ?? 0) + 1
          }),
          cities: JSON.stringify({
            ...cities,
            [data.city]: (cities[data.city] ?? 0) + 1
          })
        });
    } else {
      // This must also happen in the transaction to avoid concurrency
      await trx("visits").insert({
        [`br_${data.browser}`]: 1,
        countries: { [data.country]: 1 },
        referrers: { [data.referrer]: 1 },
        states: { [data.state]: 1 },
        cities: { [data.city]: 1 },
        [`os_${data.os}`]: 1,
        total: 1,
        link_id: data.link_id,
        user_id: data.user_id,
      });
    }

    return visit;
  });
}

async function find(match, total) {
  if (match.link_id && env.REDIS_ENABLED) {
    const key = redis.key.stats(match.link_id);
    const cached = await redis.client.get(key);
    if (cached) return JSON.parse(cached);
  }

  const stats = {
    lastDay: {
      stats: utils.getInitStats(),
      views: new Array(24).fill(0),
      total: 0
    },
    lastWeek: {
      stats: utils.getInitStats(),
      views: new Array(7).fill(0),
      total: 0
    },
    lastMonth: {
      stats: utils.getInitStats(),
      views: new Array(30).fill(0),
      total: 0
    },
    lastYear: {
      stats: utils.getInitStats(),
      views: new Array(12).fill(0),
      total: 0
    }
  };
  const visitsStream = knex("visits").where(match).stream();
  const now = new Date();

  const periods = utils.getStatsPeriods(now);

  for await (const visit of visitsStream) {
    periods.forEach(([type, fromDate]) => {
      const isIncluded = isAfter(utils.parseDatetime(visit.created_at), fromDate);
      if (!isIncluded) return;
      const diffFunction = utils.getDifferenceFunction(type);
      const diff = diffFunction(now, utils.parseDatetime(visit.created_at));
      const index = stats[type].views.length - diff - 1;
      const view = stats[type].views[index];
      const period = stats[type].stats;
      const countries = typeof visit.countries === "string" ? JSON.parse(visit.countries) : visit.countries;
      const referrers = typeof visit.referrers === "string" ? JSON.parse(visit.referrers) : visit.referrers;
      const states = typeof visit.states === "string" ? JSON.parse(visit.states) : visit.states;
      const cities = typeof visit.cities === "string" ? JSON.parse(visit.cities) : visit.cities;
      stats[type].stats = {
        browser: {
          chrome: period.browser.chrome + visit.br_chrome,
          edge: period.browser.edge + visit.br_edge,
          firefox: period.browser.firefox + visit.br_firefox,
          ie: period.browser.ie + visit.br_ie,
          opera: period.browser.opera + visit.br_opera,
          other: period.browser.other + visit.br_other,
          safari: period.browser.safari + visit.br_safari
        },
        os: {
          android: period.os.android + visit.os_android,
          ios: period.os.ios + visit.os_ios,
          linux: period.os.linux + visit.os_linux,
          macos: period.os.macos + visit.os_macos,
          other: period.os.other + visit.os_other,
          windows: period.os.windows + visit.os_windows
        },
        country: {
          ...period.country,
          ...Object.entries(countries).reduce(
            (obj, [country, count]) => ({
              ...obj,
              [country]: (period.country[country] || 0) + count
            }),
            {}
          )
        },
        referrer: {
          ...period.referrer,
          ...Object.entries(referrers).reduce(
            (obj, [referrer, count]) => ({
              ...obj,
              [referrer]: (period.referrer[referrer] || 0) + count
            }),
            {}
          )
        },
        state: {
          ...period.state,
          ...Object.entries(states).reduce(
            (obj, [state, count]) => ({
              ...obj,
              [state]: (period.state[state] || 0) + count
            }),
            {}
          )
          },
        city: {
          ...period.city,
          ...Object.entries(cities).reduce(
            (obj, [city, count]) => ({
              ...obj,
              [city]: (period.city[city] || 0) + count
            }),
            {}
          )
          }

      };
      stats[type].views[index] += visit.total;
      stats[type].total += visit.total;
    });
  }

  const response = {
    lastYear: {
      stats: utils.statsObjectToArray(stats.lastYear.stats),
      views: stats.lastYear.views,
      total: stats.lastYear.total
    },
    lastDay: {
      stats: utils.statsObjectToArray(stats.lastDay.stats),
      views: stats.lastDay.views,
      total: stats.lastDay.total
    },
    lastMonth: {
      stats: utils.statsObjectToArray(stats.lastMonth.stats),
      views: stats.lastMonth.views,
      total: stats.lastMonth.total
    },
    lastWeek: {
      stats: utils.statsObjectToArray(stats.lastWeek.stats),
      views: stats.lastWeek.views,
      total: stats.lastWeek.total
    },
  };
  console.log(JSON.stringify({
    country:response.lastYear.stats.country,
    state:response.lastYear.stats.state,
    city:response.lastYear.stats.city
  },null,2))
  if (match.link_id && env.REDIS_ENABLED) {
    const key = redis.key.stats(match.link_id);
    redis.client.set(key, JSON.stringify(response), "EX", 60);
  }

  return response;
};


module.exports = {
  add,
  find
};