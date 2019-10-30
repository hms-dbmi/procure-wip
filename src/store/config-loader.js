import fetch from "cross-fetch";
import stripJsonComments from "strip-json-comments";
import tv4 from "tv4";
import endpointListSchema from "../schemas/endpoint-list-schema.json";
import configSchema from "../schemas/config-schema.json";
import _ from "lodash";
import mergeObjects from "./merge-objects.js";

function getUrlParameter(name) {
    name = name.replace(/[[]/, '\\[').replace(/[\]]/, '\\]');
    var regex = new RegExp("[\\?&]" + name + "=([^&#]*)");
    var results = regex.exec(window.location.search);
    return results === null ? '' : decodeURIComponent(results[1].replace(/\+/g, ' '));
};

function overlayQsValues(config) {
	const manifestUrl = getUrlParameter("upload_manifest_url");
	if (manifestUrl) {
		config.upload = config.upload || {};
		config.upload.manifestUrl = manifestUrl;
		config.upload.qsManifestUrl = true;
	}
	const label = getUrlParameter("upload_label");
	if (label) {
		config.upload = config.upload || {};
		config.upload.label = label;
	}
	return config;
}


function readConfigFile(path, isOverride) {
	return fetch(path, { headers: {'Accept': 'application/json'} })
		.then( response => {
			if (!response.ok && !isOverride)
				throw new Error(`${path} - HTTP ${response.status} - ${response.statusText}`);				
			
			if (!response.ok && isOverride)
				response = { text: () => "{}" };

			return response;
		})
		.then( data => data.text() )
		.then( data => {
			try {
				return JSON.parse(stripJsonComments(data));
			} catch (e) {
				console.log(e);
				throw new Error(`${path} is not valid JSON.`);
			}
		})

}

function loadConfigFile(path, overridePath) {
	let configReaders = [readConfigFile(path)];
	if (overridePath) configReaders.push(readConfigFile(overridePath, true));

	return Promise.all(configReaders)
		.then( data => mergeObjects.merge(data) )
		.then( data => {
			tv4.validate(data, configSchema);
			if (tv4.error) {
				if (console) console.log(tv4.error);
				throw new Error(path + ": " + tv4.error.message);
			}
			return data;
		})
		//check for invalid queryProfile name and credential references (can't do this in json schema v4)
		.then( config => {
			if (!config.endpointLists) return config;
			
			const invalidEndpointId = _.find( _.keys(config.endpointLists) || [], id => {
				const v = config.endpointLists[id];
				return (
					v && v.defaults && v.defaults.queryProfile && 
					!config.queryProfiles[v.defaults.queryProfile]
				)
			});

			if (invalidEndpointId) throw new Error(
				"Invalid query profile in endpoint " + 
				path + ": /endpointLists/" + invalidEndpointId + "/defaults"
			);

			const invalidCredentialId = _.find( _.keys(config.endpointLists) || [], id => {
				const v = config.endpointLists[id];
				return (
					v && v.defaults && v.defaults.credentialId && 
					!config.credentials[v.defaults.credentialId]
				)
			});

			if (invalidCredentialId) throw new Error(
				"Invalid credential id in endpoint " + 
				path + ": /endpointLists/" + invalidCredentialId + "/defaults"
			);

			return config;
		})
		//check for invalid template name references (can't do this in json schema v4)
		.then( config => {
			if (!config.spreadsheetTemplates) return config;

			const templateNames = Object.keys(config.spreadsheetTemplates);
			templateNames.forEach( templateName => {
				const baseTemplates = config.spreadsheetTemplates[templateName].extends || [];
				baseTemplates.forEach( baseTemplateName => {
					if (templateNames.indexOf(baseTemplateName) === -1)
						throw new Error("Invalid base template name in '" + templateName + "'");
				})
			})
			return config;
		})
		.then( config => {
			if (!config.endpointLists) return config;
			return loadEndpointLists(config);
		})
		.then( config => {
			config.redirectUri = config.redirectUri || 
				window.location.href.split(/\?|#/)[0].replace(/\/*$/, "/callback.html");
			return config;
		})
		.then( config => {
			return overlayQsValues(config);
		})
		// .then( config => {
		// 	console.log(config);
		// 	return config;
		// })

}

function loadEndpointLists(config) {

	const getEndpointList = (endpointList, id) => {
		if (!endpointList.path) return;

		return fetch(endpointList.path, { headers: {'Accept': 'application/json'} })
			.then( response => {
				if (!response.ok)
					throw new Error(`${endpointList.path} - HTTP ${response.status} - ${response.statusText}`);
				return response;
			})		
			.then( data => data.text() )
			.then( data => {
				try {
					return JSON.parse(stripJsonComments(data));
				} catch (e) {
					console.log(e);
					throw new Error(`${endpointList.path} is not valid JSON.`);
				}
			})
			.then( data => {
				tv4.validate(data, endpointListSchema);
				if (tv4.error) {
					if (console) console.log(tv4.error);
					throw new Error(endpointList.path + ": " + tv4.error.message);
				}
				return data;
			})

			//check for invalid queryProfile name references and credential ids(can't do this in json schema)
			.then( data => {

				(data.entry || data.Entries || []).forEach( endpoint => {
					if (endpoint.queryProfile && !config.queryProfiles[endpoint.queryProfile]
					) throw new Error(
						"Invalid query profile in endpoint list " + 
						endpointList.path + " - " + endpoint.queryProfile
					);
				});

				(data.entry || data.Entries || []).forEach( endpoint => {
					if (endpoint.credentialId && !config.credentials[endpoint.credentialId]
					) throw new Error(
						"Invalid credential id endpoint list " + 
						endpointList.path + " - " + endpoint.credentialId
					);
				})

				return data; 

			})
			.then( data => {
				const result = (data.Entries || data.entry).map( entry => {
					let newEntry = {...entry}
					//standardize epic format
					if (newEntry.OrganizationName) {
						newEntry.name = newEntry.OrganizationName;
						delete newEntry.OrganizationName;
					}
					if (newEntry.FHIRPatientFacingURI) {
						newEntry.fhirEndpoint = newEntry.FHIRPatientFacingURI;
						delete newEntry.FHIRPatientFacingURI;
					}
					if (newEntry.id) {
						newEntry.orgId = newEntry.id;
						delete newEntry.id;
					}
					//add defaults group name
					if (endpointList.defaults)
						newEntry.defaultId = id;
					return newEntry;
				});
				return result
			})
			.catch( e => { 
				if (e.message) throw e;
				throw new Error("Error reading " + endpointList.path)
			})
	}

	return Promise.all(
		_.map( config.endpointLists, (l,id) => getEndpointList(l,id) )
	)
		.then( data => {
			const organizations = [].concat.apply([], data);
			const orgDefaults = _.mapValues( config.endpointLists, v => v.defaults );
			return {...config, orgDefaults, organizations, endpointLists: null}
		});
}

export default { loadConfigFile }