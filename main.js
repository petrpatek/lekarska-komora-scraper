const Apify = require('apify');
const cheerio = require('cheerio');
const axios = require('axios');

const ROOT_URL = 'https://www.lkcr.cz/seznam-lekaru-426.html#seznam';

async function resolveInBatches(promiseArray, batchLength = 2) {
    const promises = [];
    for (const promise of promiseArray) {
        if (typeof promise === 'function') {
            promises.push(promise());
        } else {
            promises.push(promise);
        }
        if (promises.length % batchLength === 0) await Promise.all(promises);
    }
    return Promise.all(promises);
}

Apify.main(async () => {
    const requestQueue = await Apify.openRequestQueue();
    await requestQueue.addRequest({ url: ROOT_URL, userData: { isStart: true } });

    const crawler = new Apify.BasicCrawler({
        requestQueue,
        minConcurrency: 5,
        maxConcurrency: 25,
        handleRequestFunction: async ({ request }) => {
            const { isStart, isList } = request.userData;
            if (isStart) {
                // collect combinations of
                const { data } = await axios.get(request.url);
                const $ = cheerio.load(data);
                let departments = [];
                const regions = [];

                $('select[name="filterObor"] option').each((index, element) => {
                    const departmentName = $(element).text();
                    const departmentId = $(element).attr('value');
                    departments.push({ departmentId, departmentName });
                });
                departments = departments.filter(
                    d => d.departmentId && d.departmentName,
                );

                $('select[name="filterOkresId"] option').each((index, element) => {
                    if (index >= 1) {
                        const regionName = $(element).text();
                        const regionId = $(element).attr('value');
                        regions.push({ regionName, regionId });
                    }
                });

                console.log(
                    'DEPARTMENTS: ',
                    departments.length,
                    'REGIONS: ',
                    regions.length,
                );
                const uniqueUrls = [];
                for (const { departmentId, departmentName } of departments) {
                    for (const { regionId, regionName } of regions) {
                        uniqueUrls.push({
                            url: 'https://www.lkcr.cz/seznam-lekaru-426.html',
                            userData: {
                                departmentName,
                                departmentId,
                                regionId,
                                regionName,
                                isList: true,
                            },
                            uniqueKey: `${departmentId}-${regionId}`,
                        });
                    }
                }
                await resolveInBatches(
                    uniqueUrls.map(rqst => () => requestQueue.addRequest(rqst)),
                );
            } else if (isList) {
                //       console.log(request, 'REQUEST');
                try {
                    const { data } = await axios({
                        method: 'post',
                        url: request.url,
                        headers: {
                            'content-type':
                'multipart/form-data; boundary=----WebKitFormBoundary4laiUVNTYdP4BBDP',
                        },
                        data: `------WebKitFormBoundary4laiUVNTYdP4BBDP\r\nContent-Disposition: form-data; name="filterObor"\r\n\r\n${
                            request.userData.departmentId
                        }\r\n------WebKitFormBoundary4laiUVNTYdP4BBDP\r\nContent-Disposition: form-data; name="filterOkresId"\r\n\r\n${
                            request.userData.regionId
                        }\r\n------WebKitFormBoundary4laiUVNTYdP4BBDP--!`,
                    });
                    const $ = cheerio.load(data);
                    const doctors = [];
                    $('table.seznam2 tr').each((index, element) => {
                        if (index !== 0) {
                            let name;
                            let workplace;
                            $('td', element).each((index, element) => {
                                if (index === 0) {
                                    name = $(element)
                                        .text()
                                        .trim();
                                } else if (index === 1) {
                                    workplace = $(element)
                                        .text()
                                        .trim();
                                }
                            });
                            doctors.push({ name, workplace, ...request.userData });
                        }
                    });
                    await resolveInBatches(doctors.map(doc => () => Apify.pushData(doc)));

                    // has pagination
                    const pages = [];
                    $('a[href*="paging.pageNo"]').each((index, element) => {
                        const link = $(element).attr('href');
                        pages.push({
                            url: `https://www.lkcr.cz/${link}`,
                            userData: {
                                ...request.userData,
                            },
                            uniqueKey: `${request.userData.departmentId}-${request.userData.regionId}-${link}`,
                        });
                    });
                    await resolveInBatches(pages.map(rq => () => requestQueue.addRequest(rq)));
                } catch (e) {
                    console.error(e);
                }
            }
        },
        handleFailedRequestFunction: async ({ request }) => {
            console.log(`Request ${request.url} failed too many times`);
            await Apify.pushData({
                '#debug': Apify.utils.createRequestDebugInfo(request),
            });
        },
    });

    // Run the crawler and wait for it to finish.
    await crawler.run();

    console.log('Crawler finished.');
});
