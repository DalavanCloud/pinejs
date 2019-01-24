import * as _db from '../database-layer/db';
import * as _express from 'express';

declare global {
	namespace Express {
		export interface Request {
			hooks?: InstantiatedHooks<Hooks>;
			tx?: _db.Tx;
			batch?: uriParser.UnparsedRequest[];
		}
	}
}

import * as _ from 'lodash';
import * as Promise from 'bluebird';
Promise.config({
	cancellation: true,
});

import TypedError = require('typed-error');
import { cachedCompile } from './cached-compile';

type LFModel = any[];
import * as LF2AbstractSQL from '@resin/lf-to-abstract-sql';
import * as AbstractSQLCompiler from '@resin/abstract-sql-compiler';
import { version as AbstractSQLCompilerVersion } from '@resin/abstract-sql-compiler/package.json';

let abstractSQLCompiler: typeof AbstractSQLCompiler[AbstractSQLCompiler.Engines];

declare module '@resin/abstract-sql-compiler' {
	interface AbstractSqlTable {
		fetchProcessingFields?: {
			[field: string]: (field: any) => Promise<any>;
		};
		localFields?: {
			[odataName: string]: true;
		};
	}
}

import { PinejsClientCoreFactory } from 'pinejs-client-core';
import * as sbvrTypes from '@resin/sbvr-types';
import {
	sqlNameToODataName,
	odataNameToSqlName,
	ODataBinds,
	SupportedMethod,
} from '@resin/odata-to-abstract-sql';
import deepFreeze = require('deep-freeze');
import * as env from '../config-loader/env';

import SBVRParser = require('../extended-sbvr-parser/extended-sbvr-parser');

import * as migrator from '../migrator/migrator';
import ODataMetadataGenerator = require('../sbvr-compiler/odata-metadata-generator');

// tslint:disable-next-line:no-var-requires
const devModel = require('./dev.sbvr');
import * as permissions from './permissions';
export * from './permissions';
import * as uriParser from './uri-parser';
import {
	statusCodeToError,
	InternalRequestError,
	ParsingError,
	PermissionError,
	PermissionParsingError,
	SbvrValidationError,
	SqlCompilationError,
	TranslationError,
	UnsupportedMethodError,
	BadRequestError,
	HttpError,
} from './errors';
export * from './errors';
import {
	rollbackRequestHooks,
	instantiateHooks,
	HookBlueprint,
	InstantiatedHooks,
} from './hooks';

import * as controlFlow from './control-flow';
import * as memoize from 'memoizee';
import memoizeWeak = require('memoizee/weak');
const memoizedCompileRule = memoizeWeak(
	(abstractSqlQuery: AbstractSQLCompiler.AbstractSqlQuery) => {
		const sqlQuery = abstractSQLCompiler.compileRule(abstractSqlQuery);
		const modifiedFields = abstractSQLCompiler.getModifiedFields(
			abstractSqlQuery,
		);
		if (modifiedFields != null) {
			deepFreeze(modifiedFields);
		}
		return {
			sqlQuery,
			modifiedFields,
		};
	},
	{ max: env.cache.abstractSqlCompiler.max },
);

const compileRequest = (request: uriParser.ODataRequest) => {
	if (request.abstractSqlQuery != null) {
		try {
			const { sqlQuery, modifiedFields } = memoizedCompileRule(
				request.abstractSqlQuery,
			);
			request.sqlQuery = sqlQuery;
			request.modifiedFields = modifiedFields;
		} catch (err) {
			api[request.vocabulary].logger.error(
				'Failed to compile abstract sql: ',
				request.abstractSqlQuery,
				err,
			);
			throw new SqlCompilationError(err);
		}
	}
	return request;
};

const { DEBUG } = process.env;

export let db = (undefined as any) as _db.Database;

export { sbvrTypes };

import { version as LF2AbstractSQLVersion } from '@resin/lf-to-abstract-sql/package.json';
import { version as sbvrTypesVersion } from '@resin/lf-to-abstract-sql/package.json';
import { AnyObject } from './sbvr-utils';
import { Model } from '../config-loader/config-loader';
import {
	RequiredField,
	OptionalField,
	Resolvable,
	ExcludeField,
} from './common-types';
const LF2AbstractSQLTranslator = LF2AbstractSQL.createTranslator(sbvrTypes);
const LF2AbstractSQLTranslatorVersion = `${LF2AbstractSQLVersion}+${sbvrTypesVersion}`;

const seModels: {
	[vocabulary: string]: string;
} = {};
const abstractSqlModels: {
	[vocabulary: string]: AbstractSQLCompiler.AbstractSqlModel;
} = {};
const sqlModels: {
	[vocabulary: string]: AbstractSQLCompiler.SqlModel;
} = {};
const odataMetadata: {
	[vocabulary: string]: {};
} = {};

export interface HookReq {
	user?: User;
	apiKey?: ApiKey;
	method: string;
	url: string;
	query: AnyObject;
	params: AnyObject;
	body: AnyObject;
	custom?: AnyObject;
	tx?: _db.Tx;
	hooks?: InstantiatedHooks<Hooks>;
}

export type HookArgs = {
	req: HookReq;
	request: HookRequest;
	api: PinejsClient;
	tx?: _db.Tx;
};
export type HookResponse = Promise<any> | null | void;
export type HookRequest = uriParser.ODataRequest;

export interface Hooks {
	PREPARSE?: (options: HookArgs) => HookResponse;
	POSTPARSE?: (options: HookArgs) => HookResponse;
	PRERUN?: (options: HookArgs & { tx: _db.Tx }) => HookResponse;
	POSTRUN?: (options: HookArgs & { tx: _db.Tx; result: any }) => HookResponse;
	PRERESPOND?: (
		options: HookArgs & {
			tx: _db.Tx;
			result: any;
			res: any;
			data?: any;
		},
	) => HookResponse;
}
type HookBlueprints = { [key in keyof Hooks]: HookBlueprint[] };
const hookNames: Array<keyof Hooks> = [
	'PREPARSE',
	'POSTPARSE',
	'PRERUN',
	'POSTRUN',
	'PRERESPOND',
];
const isValidHook = (x: any): x is keyof Hooks => _.includes(hookNames, x);

interface VocabHooks {
	[resourceName: string]: HookBlueprints;
}
interface MethodHooks {
	[vocab: string]: VocabHooks;
}
const apiHooks = {
	all: {} as MethodHooks,
	GET: {} as MethodHooks,
	PUT: {} as MethodHooks,
	POST: {} as MethodHooks,
	PATCH: {} as MethodHooks,
	MERGE: {} as MethodHooks,
	DELETE: {} as MethodHooks,
	OPTIONS: {} as MethodHooks,
};

// Share hooks between merge and patch since they are the same operation, just MERGE was the OData intermediary until the HTTP spec added PATCH.
apiHooks.MERGE = apiHooks.PATCH;

export interface Actor {
	permissions?: string[];
}

export interface User extends Actor {
	id: number;
	actor: number;
}

export interface ApiKey extends Actor {
	key: string;
}

interface Response {
	status?: number;
	headers?: {
		[headerName: string]: any;
	};
	body?: AnyObject;
}

const memoizedResolvedSynonym = memoizeWeak(
	(
		abstractSqlModel: AbstractSQLCompiler.AbstractSqlModel,
		resourceName: string,
	) => {
		const sqlName = odataNameToSqlName(resourceName);
		return _(sqlName)
			.split('-')
			.map(resourceName =>
				_.get(abstractSqlModel, ['synonyms', resourceName], resourceName),
			)
			.join('-');
	},
	{ primitive: true },
);

export const resolveSynonym = (
	request: Pick<
		uriParser.ODataRequest,
		'abstractSqlModel' | 'resourceName' | 'vocabulary'
	>,
): string => {
	const abstractSqlModel = getAbstractSqlModel(request);
	return memoizedResolvedSynonym(abstractSqlModel, request.resourceName);
};

export const resolveNavigationResource = (
	request: Pick<
		uriParser.ODataRequest,
		'resourceName' | 'vocabulary' | 'abstractSqlModel'
	>,
	navigationName: string,
): string => {
	const abstractSqlModel = getAbstractSqlModel(request);
	const navigation = _(odataNameToSqlName(navigationName))
		.split('-')
		.flatMap(resourceName =>
			resolveSynonym({
				resourceName,
				vocabulary: request.vocabulary,
				abstractSqlModel,
			}).split('-'),
		)
		.concat('$')
		.value();
	const resolvedResourceName = resolveSynonym(request);
	const mapping = _.get(
		abstractSqlModel.relationships[resolvedResourceName],
		navigation,
	) as undefined | AbstractSQLCompiler.RelationshipMapping;
	if (mapping == null) {
		throw new Error(
			`Cannot navigate from '${request.resourceName}' to '${navigationName}'`,
		);
	}
	if (mapping.length < 2) {
		throw new Error(
			`'${
				request.resourceName
			}' to '${navigationName}' is a field not a navigation`,
		);
	}
	return sqlNameToODataName(abstractSqlModel.tables[mapping[1][0]].name);
};

// TODO: Clean this up and move it into the db module.
const prettifyConstraintError = (
	err: Error | TypedError,
	resourceName: string,
) => {
	if (err instanceof db.ConstraintError) {
		let matches: RegExpExecArray | null = null;
		if (err instanceof db.UniqueConstraintError) {
			switch (db.engine) {
				case 'mysql':
					matches = /ER_DUP_ENTRY: Duplicate entry '.*?[^\\]' for key '(.*?[^\\])'/.exec(
						err.message,
					);
					break;
				case 'postgres':
					const tableName = odataNameToSqlName(resourceName);
					matches = new RegExp('"' + tableName + '_(.*?)_key"').exec(
						err.message,
					);
					break;
			}
			// We know it's the right error type, so if matches exists just throw a generic error message, since we have failed to get the info for a more specific one.
			if (matches == null) {
				throw new db.UniqueConstraintError('Unique key constraint violated');
			}
			const columns = matches[1].split('_');
			throw new db.UniqueConstraintError(
				'"' +
					columns.map(sqlNameToODataName).join('" and "') +
					'" must be unique.',
			);
		}

		if (err instanceof db.ForeignKeyConstraintError) {
			switch (db.engine) {
				case 'mysql':
					matches = /ER_ROW_IS_REFERENCED_: Cannot delete or update a parent row: a foreign key constraint fails \(".*?"\.(".*?").*/.exec(
						err.message,
					);
					break;
				case 'postgres':
					const tableName = odataNameToSqlName(resourceName);
					matches = new RegExp(
						'"' +
							tableName +
							'" violates foreign key constraint ".*?" on table "(.*?)"',
					).exec(err.message);
					if (matches == null) {
						matches = new RegExp(
							'"' +
								tableName +
								'" violates foreign key constraint "' +
								tableName +
								'_(.*?)_fkey"',
						).exec(err.message);
					}
					break;
			}
			// We know it's the right error type, so if no matches exists just throw a generic error message, since we have failed to get the info for a more specific one.
			if (matches == null) {
				throw new db.ForeignKeyConstraintError(
					'Foreign key constraint violated',
				);
			}
			throw new db.ForeignKeyConstraintError(
				'Data is referenced by ' + sqlNameToODataName(matches[1]) + '.',
			);
		}

		throw err;
	}
};

export const resolveOdataBind = (odataBinds: ODataBinds, value: any) => {
	if (_.isObject(value) && value.bind != null) {
		[, value] = odataBinds[value.bind];
	}
	return value;
};

const getAndCheckBindValues = (
	vocab: string,
	odataBinds: ODataBinds = [],
	bindings: AbstractSQLCompiler.Binding[],
	values: AnyObject = {},
) => {
	const sqlModelTables = sqlModels[vocab].tables;
	return Promise.map(bindings, binding => {
		let fieldName: string;
		let field: { dataType: string };
		let value: any;
		if (binding[0] === 'Bind') {
			const bindValue = binding[1];
			if (_.isArray(bindValue)) {
				let tableName;
				[tableName, fieldName] = bindValue;

				const referencedName = tableName + '.' + fieldName;
				value = values[referencedName];
				if (value === undefined) {
					value = values[fieldName];
				}

				value = resolveOdataBind(odataBinds, value);

				const sqlTableName = odataNameToSqlName(tableName);
				const sqlFieldName = odataNameToSqlName(fieldName);
				let maybeField = _.find(sqlModelTables[sqlTableName].fields, {
					fieldName: sqlFieldName,
				});
				if (maybeField == null) {
					throw new Error(`Could not find field '${fieldName}'`);
				}
				field = maybeField;
			} else if (_.isInteger(bindValue)) {
				if (bindValue >= odataBinds.length) {
					console.error(
						`Invalid binding number '${bindValue}' for binds: `,
						odataBinds,
					);
					throw new Error('Invalid binding');
				}
				let dataType;
				[dataType, value] = odataBinds[bindValue];
				field = { dataType };
			} else if (_.isString(bindValue)) {
				if (!odataBinds.hasOwnProperty(bindValue)) {
					console.error(
						`Invalid binding '${bindValue}' for binds: `,
						odataBinds,
					);
					throw new Error('Invalid binding');
				}
				let dataType;
				[dataType, value] = odataBinds[bindValue];
				field = { dataType };
			} else {
				throw new Error(`Unknown binding: ${binding}`);
			}
		} else {
			let dataType;
			[dataType, value] = binding;
			field = { dataType };
		}

		if (value === undefined) {
			throw new Error(`Bind value cannot be undefined: ${binding}`);
		}

		return abstractSQLCompiler
			.dataTypeValidate(value, field)
			.tapCatch((e: Error) => {
				e.message = '"' + fieldName + '" ' + e.message;
			});
	});
};

const checkModifiedFields = (
	referencedFields: AbstractSQLCompiler.ReferencedFields,
	modifiedFields: AbstractSQLCompiler.ModifiedFields,
) => {
	const refs = referencedFields[modifiedFields.table];
	// If there are no referenced fields of the modified table then the rule is not affected
	if (refs == null) {
		return false;
	}
	// If there are no specific fields listed then that means they were all modified (ie insert/delete) and so the rule can be affected
	if (modifiedFields.fields == null) {
		return true;
	}
	// Otherwise check if there are any matching fields to see if the rule is affected
	return _.intersection(refs, modifiedFields.fields).length > 0;
};
const isRuleAffected = (
	rule: AbstractSQLCompiler.SqlRule,
	request?: uriParser.ODataRequest,
) => {
	// If there is no abstract sql query then nothing was modified
	if (request == null || request.abstractSqlQuery == null) {
		return false;
	}
	// If for some reason there are no referenced fields known for the rule then we just assume it may have been modified
	if (rule.referencedFields == null) {
		return true;
	}
	const { modifiedFields } = request;
	// If we can't get any modified fields we assume the rule may have been modified
	if (modifiedFields == null) {
		console.warn(
			`Could not determine the modified table/fields info for '${
				request.method
			}' to ${request.vocabulary}`,
			request.abstractSqlQuery,
		);
		return true;
	}
	if (_.isArray(modifiedFields)) {
		return _.some(
			modifiedFields,
			_.partial(checkModifiedFields, rule.referencedFields),
		);
	}
	return checkModifiedFields(rule.referencedFields, modifiedFields);
};

export const validateModel = (
	tx: _db.Tx,
	modelName: string,
	request?: uriParser.ODataRequest,
) => {
	return Promise.map(sqlModels[modelName].rules, rule => {
		if (!isRuleAffected(rule, request)) {
			// If none of the fields intersect we don't need to run the rule! :D
			return;
		}

		return getAndCheckBindValues(modelName, undefined, rule.bindings, undefined)
			.then(values => tx.executeSql(rule.sql, values))
			.then(result => {
				const v = result.rows[0].result;
				if (v === false || v === 0 || v === '0') {
					throw new SbvrValidationError(rule.structuredEnglish);
				}
			});
	});
};

export const generateLfModel = (seModel: string): LFModel =>
	cachedCompile('lfModel', SBVRParser.version, seModel, () =>
		SBVRParser.matchAll(seModel, 'Process'),
	);

export const generateAbstractSqlModel = (
	lfModel: LFModel,
): AbstractSQLCompiler.AbstractSqlModel =>
	cachedCompile(
		'abstractSqlModel',
		LF2AbstractSQLTranslatorVersion,
		lfModel,
		() => LF2AbstractSQLTranslator(lfModel, 'Process'),
	);

const generateModels = (vocab: string, seModel: string) => {
	let lfModel;
	try {
		lfModel = generateLfModel(seModel);
	} catch (e) {
		console.error(`Error parsing model '${vocab}':`, e);
		throw new Error(`Error parsing model '${vocab}': ` + e);
	}

	let abstractSqlModel: ReturnType<typeof generateAbstractSqlModel>;
	try {
		abstractSqlModel = generateAbstractSqlModel(lfModel);
	} catch (e) {
		console.error(`Error translating model '${vocab}':`, e);
		throw new Error(`Error translating model '${vocab}': ` + e);
	}

	let sqlModel: ReturnType<typeof abstractSQLCompiler.compileSchema>;
	let metadata: ReturnType<typeof ODataMetadataGenerator>;
	try {
		sqlModel = cachedCompile(
			'sqlModel',
			AbstractSQLCompilerVersion + '+' + db.engine,
			abstractSqlModel,
			() => abstractSQLCompiler.compileSchema(abstractSqlModel),
		);
		metadata = cachedCompile(
			'metadata',
			ODataMetadataGenerator.version,
			{ vocab, sqlModel },
			() => ODataMetadataGenerator(vocab, sqlModel),
		);
	} catch (e) {
		console.error(`Error compiling model '${vocab}':`, e);
		throw new Error(`Error compiling model '${vocab}': ` + e);
	}
	return { lfModel, abstractSqlModel, sqlModel, metadata };
};

export const executeModel = (
	tx: _db.Tx,
	model: RequiredField<Model, 'apiRoot' | 'modelText'>,
	callback?: (err?: Error) => void,
): Promise<void> => executeModels(tx, [model], callback);

interface CompiledModel {
	vocab: string;
	se: string;
	lf: LFModel;
	abstractsql: AbstractSQLCompiler.AbstractSqlModel;
	sql: AbstractSQLCompiler.SqlModel;
}
export const executeModels = (
	tx: _db.Tx,
	models: Array<RequiredField<Model, 'apiRoot' | 'modelText'>>,
	callback?: (err?: Error) => void,
): Promise<void> =>
	Promise.map(models, model => {
		const seModel = model.modelText;
		const vocab = model.apiRoot;

		return migrator.run(tx, model).then(() => {
			const { lfModel, abstractSqlModel, sqlModel, metadata } = generateModels(
				vocab,
				seModel,
			);

			// Create tables related to terms and fact types
			// Use `Promise.reduce` to run statements sequentially, as the order of the CREATE TABLE statements matters (eg. for foreign keys).
			return Promise.each(sqlModel.createSchema, createStatement => {
				const promise = tx.executeSql(createStatement);
				if (db.engine === 'websql') {
					promise.catch(err => {
						console.warn(
							"Ignoring errors in the create table statements for websql as it doesn't support CREATE IF NOT EXISTS",
							err,
						);
					});
				}
				return promise;
			})
				.then(() => migrator.postRun(tx, model))
				.then(() => {
					seModels[vocab] = seModel;
					_.each(abstractSqlModel.tables, table => {
						getLocalFields(table);
						getFetchProcessingFields(table);
					});
					deepFreeze(abstractSqlModel);
					abstractSqlModels[vocab] = abstractSqlModel;
					sqlModels[vocab] = sqlModel;
					odataMetadata[vocab] = metadata;

					// Validate the [empty] model according to the rules.
					// This may eventually lead to entering obligatory data.
					// For the moment it blocks such models from execution.
					return validateModel(tx, vocab);
				})
				.then(
					(): CompiledModel => {
						// TODO: Can we do this without the cast?
						api[vocab] = new PinejsClient('/' + vocab + '/') as LoggingClient;
						api[vocab].logger = _.cloneDeep(console);
						if (model.logging != null) {
							const defaultSetting = _.get(model.logging, 'default', true);
							for (const k in model.logging) {
								const key = k as keyof Console;
								if (
									_.isFunction(api[vocab].logger[key]) &&
									!_.get(model.logging, [key], defaultSetting)
								) {
									api[vocab].logger[key] = _.noop;
								}
							}
						}

						return {
							vocab,
							se: seModel,
							lf: lfModel,
							abstractsql: abstractSqlModel,
							sql: sqlModel,
						};
					},
				);
		});
		// Only update the dev models once all models have finished executing.
	})
		.map((model: CompiledModel) => {
			const updateModel = (modelType: keyof CompiledModel) => {
				return api.dev
					.get({
						resource: 'model',
						passthrough: {
							tx,
							req: permissions.rootRead,
						},
						options: {
							$select: 'id',
							$filter: {
								is_of__vocabulary: model.vocab,
								model_type: modelType,
							},
						},
					})
					.then(result => {
						let method: SupportedMethod = 'POST';
						let uri = '/dev/model';
						const body: AnyObject = {
							is_of__vocabulary: model.vocab,
							model_value: model[modelType],
							model_type: modelType,
						};
						const id = _.get(result, ['0', 'id']);
						if (id != null) {
							uri += '(' + id + ')';
							method = 'PATCH';
							body.id = id;
						} else {
							uri += '?returnResource=false';
						}

						return runURI(method, uri, body, tx, permissions.root);
					});
			};

			return Promise.map(['se', 'lf', 'abstractsql', 'sql'], updateModel);
		})
		.tapCatch(() => Promise.map(models, ({ apiRoot }) => cleanupModel(apiRoot)))
		.return()
		.nodeify(callback);

const cleanupModel = (vocab: string) => {
	delete seModels[vocab];
	delete abstractSqlModels[vocab];
	delete sqlModels[vocab];
	delete odataMetadata[vocab];
	delete api[vocab];
};

const mergeHooks = (a: HookBlueprints, b: HookBlueprints): HookBlueprints => {
	return _.mergeWith({}, a, b, (a, b) => {
		if (_.isArray(a)) {
			return a.concat(b);
		}
	});
};
type HookMethod = keyof typeof apiHooks;
const getResourceHooks = (vocabHooks: VocabHooks, resourceName?: string) => {
	if (vocabHooks == null) {
		return {};
	}
	// When getting the hooks list for the sake of PREPARSE hooks
	// we don't know the resourceName we'll be acting on yet
	if (resourceName == null) {
		return vocabHooks['all'];
	}
	return mergeHooks(vocabHooks[resourceName], vocabHooks['all']);
};
const getVocabHooks = (
	methodHooks: MethodHooks,
	vocabulary: string,
	resourceName?: string,
) => {
	if (methodHooks == null) {
		return {};
	}
	return mergeHooks(
		getResourceHooks(methodHooks[vocabulary], resourceName),
		getResourceHooks(methodHooks['all'], resourceName),
	);
};
const getMethodHooks = memoize(
	(method: SupportedMethod, vocabulary: string, resourceName?: string) =>
		mergeHooks(
			getVocabHooks(apiHooks[method], vocabulary, resourceName),
			getVocabHooks(apiHooks['all'], vocabulary, resourceName),
		),
	{ primitive: true },
);
const getHooks = (
	request: Pick<
		OptionalField<HookRequest, 'resourceName'>,
		'resourceName' | 'method' | 'vocabulary'
	>,
): InstantiatedHooks<Hooks> => {
	let { resourceName } = request;
	if (resourceName != null) {
		resourceName = resolveSynonym(request as Pick<
			HookRequest,
			'resourceName' | 'method' | 'vocabulary'
		>);
	}
	return instantiateHooks(
		getMethodHooks(request.method, request.vocabulary, resourceName),
	);
};
getHooks.clear = () => getMethodHooks.clear();

const runHooks = Promise.method(
	<T extends keyof Hooks>(
		hookName: T,
		args: Parameters<NonNullable<Hooks[T]>>[0],
	) => {
		const { request, req, tx } = args;
		let hooks = (req.hooks && req.hooks[hookName]) || [];
		const requestHooks = request.hooks ? request.hooks[hookName] : null;
		if (requestHooks != null) {
			hooks = hooks.concat(requestHooks);
		}
		if (hooks.length === 0) {
			return;
		}
		if (request != null) {
			const { vocabulary } = request;
			Object.defineProperty(args, 'api', {
				get: _.once(() =>
					api[vocabulary].clone({
						passthrough: { req, tx },
					}),
				),
			});
		}
		return Promise.map(hooks, hook => hook.run(args)).return();
	},
);

export const deleteModel = (
	vocabulary: string,
	callback?: (err?: Error) => void,
) => {
	return db
		.transaction(tx => {
			const dropStatements: Array<Promise<any>> = _.map(
				_.get(sqlModels, [vocabulary, 'dropSchema']),
				(dropStatement: string) => tx.executeSql(dropStatement),
			);
			return Promise.all(
				dropStatements.concat([
					api.dev.delete({
						resource: 'model',
						passthrough: {
							tx,
							req: permissions.root,
						},
						options: {
							$filter: {
								is_of__vocabulary: vocabulary,
							},
						},
					}),
				]),
			);
		})
		.then(() => cleanupModel(vocabulary))
		.nodeify(callback);
};

const isWhereNode = (
	x: AbstractSQLCompiler.AbstractSqlType,
): x is AbstractSQLCompiler.WhereNode => x[0] === 'Where';
const isEqualsNode = (
	x: AbstractSQLCompiler.AbstractSqlType,
): x is AbstractSQLCompiler.EqualsNode => x[0] === 'Equals';
export const getID = (vocab: string, request: uriParser.ODataRequest) => {
	if (request.abstractSqlQuery == null) {
		throw new Error('Can only get the id if an abstractSqlQuery is provided');
	}
	const { idField } = sqlModels[vocab].tables[request.resourceName];
	for (const whereClause of request.abstractSqlQuery) {
		if (isWhereNode(whereClause)) {
			for (const comparison of whereClause.slice(1)) {
				if (isEqualsNode(comparison)) {
					if (comparison[1][2] === idField) {
						return comparison[2][1];
					}
					if (comparison[2][2] === idField) {
						return comparison[1][1];
					}
				}
			}
		}
	}
	return 0;
};

const checkForExpansion = Promise.method(
	(
		vocab: string,
		abstractSqlModel: AbstractSQLCompiler.AbstractSqlModel,
		parentResourceName: string,
		fieldName: string,
		instance: _db.Row,
	) => {
		let field = instance[fieldName];
		if (field == null) {
			return;
		}

		if (_.isString(field)) {
			try {
				field = JSON.parse(field);
			} catch (_e) {
				// If we can't JSON.parse the field then we use it directly.
			}
		}

		if (_.isArray(field)) {
			const mappingResourceName = resolveNavigationResource(
				{
					abstractSqlModel,
					vocabulary: vocab,
					resourceName: parentResourceName,
				},
				fieldName,
			);
			return processOData(
				vocab,
				abstractSqlModel,
				mappingResourceName,
				field,
			).then(expandedField => {
				instance[fieldName] = expandedField;
			});
		} else {
			const mappingResourceName = resolveNavigationResource(
				{
					abstractSqlModel,
					vocabulary: vocab,
					resourceName: parentResourceName,
				},
				fieldName,
			);
			instance[fieldName] = {
				__deferred: {
					uri: '/' + vocab + '/' + mappingResourceName + '(' + field + ')',
				},
				__id: field,
			};
		}
	},
);

const odataResourceURI = (
	vocab: string,
	resourceName: string,
	id: string | number,
) => {
	if (_.isString(id)) {
		id = "'" + encodeURIComponent(id) + "'";
	}
	return '/' + vocab + '/' + resourceName + '(' + id + ')';
};

const getLocalFields = (table: AbstractSQLCompiler.AbstractSqlTable) => {
	if (table.localFields == null) {
		table.localFields = {};
		for (const { fieldName, dataType } of table.fields) {
			if (dataType !== 'ForeignKey') {
				const odataName = sqlNameToODataName(fieldName);
				table.localFields[odataName] = true;
			}
		}
	}
	return table.localFields;
};
const getFetchProcessingFields = (
	table: AbstractSQLCompiler.AbstractSqlTable,
) => {
	if (table.fetchProcessingFields == null) {
		table.fetchProcessingFields = _(table.fields)
			.filter(
				({ dataType }) =>
					sbvrTypes[dataType] != null &&
					sbvrTypes[dataType].fetchProcessing != null,
			)
			.map(({ fieldName, dataType }) => {
				const odataName = sqlNameToODataName(fieldName);
				return [odataName, sbvrTypes[dataType].fetchProcessing];
			})
			.fromPairs()
			.value();
	}
	return table.fetchProcessingFields!;
};
const processOData = (
	vocab: string,
	abstractSqlModel: AbstractSQLCompiler.AbstractSqlModel,
	resourceName: string,
	rows: _db.Result['rows'],
): Promise<number | _db.Row[]> => {
	if (rows.length === 0) {
		return Promise.resolve([]);
	}

	if (rows.length === 1) {
		if (rows[0].$count != null) {
			const count = parseInt(rows[0].$count, 10);
			return Promise.resolve(count);
		}
	}

	const sqlResourceName = resolveSynonym({
		abstractSqlModel,
		vocabulary: vocab,
		resourceName,
	});
	const table = abstractSqlModel.tables[sqlResourceName];

	const odataIdField = sqlNameToODataName(table.idField);
	const instances = rows.map(instance => {
		instance.__metadata = {
			// TODO: This should support non-number id fields
			uri: odataResourceURI(vocab, resourceName, +instance[odataIdField]),
			type: '',
		};
		return instance;
	});

	let instancesPromise = Promise.resolve();

	const localFields = getLocalFields(table);
	// We check that it's not a local field, rather than that it is a foreign key because of the case where the foreign key is on the other resource
	// and hence not known to this resource
	const expandableFields = _.filter(
		_.keys(instances[0]),
		fieldName =>
			!_.startsWith(fieldName, '__') && !localFields.hasOwnProperty(fieldName),
	);
	if (expandableFields.length > 0) {
		instancesPromise = Promise.map(instances, instance =>
			Promise.map(expandableFields, fieldName =>
				checkForExpansion(
					vocab,
					abstractSqlModel,
					sqlResourceName,
					fieldName,
					instance,
				),
			),
		).return();
	}

	const fetchProcessingFields = getFetchProcessingFields(table);
	const processedFields = _.filter(
		_.keys(instances[0]),
		fieldName =>
			!_.startsWith(fieldName, '__') &&
			fetchProcessingFields.hasOwnProperty(fieldName),
	);
	if (processedFields.length > 0) {
		instancesPromise = instancesPromise
			.then(() => {
				return Promise.map(instances, instance => {
					return Promise.map(processedFields, resourceName => {
						return fetchProcessingFields[resourceName](
							instance[resourceName],
						).then(result => {
							instance[resourceName] = result;
						});
					});
				});
			})
			.return();
	}

	return instancesPromise.return(instances);
};

export const runRule = (() => {
	const LF2AbstractSQLPrepHack = LF2AbstractSQL.LF2AbstractSQLPrep._extend({
		CardinalityOptimisation: function() {
			this._pred(false);
		},
	});
	const translator = LF2AbstractSQL.LF2AbstractSQL.createInstance();
	translator.addTypes(sbvrTypes);
	return (vocab: string, rule: string, callback?: (err?: Error) => void) => {
		return Promise.try(() => {
			const seModel = seModels[vocab];
			const { logger } = api[vocab];
			let lfModel: LFModel;
			let slfModel: LFModel;
			let abstractSqlModel: AbstractSQLCompiler.AbstractSqlModel;

			try {
				lfModel = SBVRParser.matchAll(seModel + '\nRule: ' + rule, 'Process');
			} catch (e) {
				logger.error('Error parsing rule', rule, e, e.stack);
				throw new Error(`Error parsing rule'${rule}': ${e}`);
			}

			const ruleLF = lfModel.pop();

			try {
				slfModel = LF2AbstractSQL.LF2AbstractSQLPrep.match(lfModel, 'Process');
				slfModel.push(ruleLF);
				slfModel = LF2AbstractSQLPrepHack.match(slfModel, 'Process');

				translator.reset();
				abstractSqlModel = translator.match(slfModel, 'Process');
			} catch (e) {
				logger.error('Error compiling rule', rule, e, e.stack);
				throw new Error(`Error compiling rule '${rule}': ${e}`);
			}

			const formulationType = ruleLF[1][0];
			let resourceName: string;
			if (ruleLF[1][1][0] === 'LogicalNegation') {
				resourceName = ruleLF[1][1][1][1][2][1];
			} else {
				resourceName = ruleLF[1][1][1][2][1];
			}

			let fetchingViolators = false;
			const ruleAbs = _.last(abstractSqlModel.rules);
			if (ruleAbs == null) {
				throw new Error('Unable to generate rule');
			}
			let ruleBody = _.find(ruleAbs, node => node[0] === 'Body') as [
				'Body',
				...any[]
			];
			if (
				ruleBody[1][0] === 'Not' &&
				ruleBody[1][1][0] === 'Exists' &&
				ruleBody[1][1][1][0] === 'SelectQuery'
			) {
				// Remove the not exists
				ruleBody[1] = ruleBody[1][1][1];
				fetchingViolators = true;
			} else if (
				ruleBody[1][0] === 'Exists' &&
				ruleBody[1][1][0] === 'SelectQuery'
			) {
				// Remove the exists
				ruleBody[1] = ruleBody[1][1];
			} else {
				throw new Error('Unsupported rule formulation');
			}

			const wantNonViolators =
				formulationType in
				['PossibilityFormulation', 'PermissibilityFormulation'];
			if (wantNonViolators === fetchingViolators) {
				// What we want is the opposite of what we're getting, so add a not to the where clauses
				ruleBody[1] = _.map(ruleBody[1], queryPart => {
					if (queryPart[0] !== 'Where') {
						return queryPart;
					}
					if (queryPart.length > 2) {
						throw new Error('Unsupported rule formulation');
					}
					return ['Where', ['Not', queryPart[1]]];
				});
			}

			// Select all
			ruleBody[1] = _.map(ruleBody[1], queryPart => {
				if (queryPart[0] !== 'Select') {
					return queryPart;
				}
				return ['Select', '*'];
			});
			const compiledRule = abstractSQLCompiler.compileRule(ruleBody);
			if (_.isArray(compiledRule)) {
				throw new Error('Unexpected query generated');
			}
			return getAndCheckBindValues(
				vocab,
				undefined,
				compiledRule.bindings,
				undefined,
			)
				.then(values => {
					return db.executeSql(compiledRule.query, values);
				})
				.then(result => {
					const table = abstractSqlModels[vocab].tables[resourceName];
					const odataIdField = sqlNameToODataName(table.idField);
					let ids = result.rows.map(row => row[table.idField]);
					ids = _.uniq(ids);
					ids = _.map(ids, id => odataIdField + ' eq ' + id);
					let filter: string;
					if (ids.length > 0) {
						filter = ids.join(' or ');
					} else {
						filter = '0 eq 1';
					}
					return runURI(
						'GET',
						'/' +
							vocab +
							'/' +
							sqlNameToODataName(table.resourceName) +
							'?$filter=' +
							filter,
						undefined,
						undefined,
						permissions.rootRead,
					).then((result: AnyObject) => {
						result.__formulationType = formulationType;
						result.__resourceName = resourceName;
						return result;
					});
				});
		}).nodeify(callback);
	};
})();

export type Passthrough = AnyObject & {
	req?: {
		user?: User;
	};
	tx?: _db.Tx;
};

export class PinejsClient extends PinejsClientCoreFactory(Promise)<
	PinejsClient,
	Promise<{}>,
	Promise<PinejsClientCoreFactory.PromiseResultTypes>
> {
	passthrough: Passthrough;
	_request({
		method,
		url,
		body,
		tx,
		req,
		custom,
	}: {
		method: string;
		url: string;
		body?: AnyObject;
		tx?: _db.Tx;
		req?: permissions.PermissionReq;
		custom?: AnyObject;
	}) {
		return runURI(method, url, body, tx, req, custom);
	}
}

type LoggingClient = PinejsClient & {
	logger: Console;
};
export const api: {
	[vocab: string]: LoggingClient;
} = {};

// We default to guest only permissions if no req object is passed in
export const runURI = (
	method: string,
	uri: string,
	body: AnyObject = {},
	tx?: _db.Tx,
	req?: permissions.PermissionReq,
	custom?: AnyObject,
	callback?: (
		err?: Error,
		result?: PinejsClientCoreFactory.PromiseResultTypes,
	) => void,
): Promise<PinejsClientCoreFactory.PromiseResultTypes> => {
	if (body == null) {
		body = {};
	}
	if (callback != null && !_.isFunction(callback)) {
		const message = 'Called runURI with a non-function callback?!';
		console.trace(message);
		return Promise.reject(message);
	}

	let user: User | undefined;
	let apiKey: ApiKey | undefined;

	if (req != null && _.isObject(req)) {
		user = req.user;
		apiKey = req.apiKey;
	} else {
		if (req != null) {
			console.warn('Non-object req passed to runURI?', req, new Error().stack);
		}
		user = {
			id: 0,
			actor: 0,
			permissions: [],
		};
	}

	// Remove undefined values from the body, as normally they would be removed by the JSON conversion
	_.each(body, (v, k) => {
		if (v === undefined) {
			delete body[k];
		}
	});

	const emulatedReq: _express.Request = {
		on: _.noop,
		custom,
		user,
		apiKey,
		method,
		url: uri,
		body,
		params: {},
		query: {},
		tx,
	} as any;

	return new Promise((resolve, reject) => {
		const res: _express.Response = {
			on: _.noop,
			statusCode: 200,
			status(statusCode: number) {
				this.statusCode = statusCode;
				return this;
			},
			sendStatus: (statusCode: number) => {
				if (statusCode >= 400) {
					const ErrorClass =
						statusCodeToError[statusCode as keyof typeof statusCodeToError];
					if (ErrorClass != null) {
						reject(new ErrorClass());
					} else {
						reject(new HttpError(statusCode));
					}
				} else {
					resolve();
				}
			},
			send(statusCode: number) {
				if (statusCode == null) {
					statusCode = this.statusCode;
				}
				this.sendStatus(statusCode);
			},
			json(data: any, statusCode: number) {
				if (statusCode == null) {
					statusCode = this.statusCode;
				}
				if (statusCode >= 400) {
					const ErrorClass =
						statusCodeToError[statusCode as keyof typeof statusCodeToError];
					if (ErrorClass != null) {
						reject(new ErrorClass(data));
					} else {
						reject(new HttpError(statusCode, data));
					}
				} else {
					resolve(data);
				}
			},
			set: _.noop,
			type: _.noop,
		} as any;

		const next = (route?: string) => {
			console.warn('Next called on a runURI?!', method, uri, route);
			res.sendStatus(500);
		};

		handleODataRequest(emulatedReq, res, next);
	}).nodeify(callback);
};

export const getAbstractSqlModel = (
	request: Pick<uriParser.ODataRequest, 'vocabulary' | 'abstractSqlModel'>,
): AbstractSQLCompiler.AbstractSqlModel => {
	if (request.abstractSqlModel == null) {
		request.abstractSqlModel = abstractSqlModels[request.vocabulary];
	}
	return request.abstractSqlModel;
};

export const getAffectedIds = Promise.method(
	({
		req,
		request,
		tx,
	}: {
		req: HookReq;
		request: HookRequest;
		tx: _db.Tx;
	}): Promise<number[]> => {
		if (request.method === 'GET') {
			// GET requests don't affect anything so passing one to this method is a mistake
			throw new Error('Cannot call `getAffectedIds` with a GET request');
		}
		// We reparse to make sure we get a clean odataQuery, without permissions already added
		// And we use the request's url rather than the req for things like batch where the req url is ../$batch
		return uriParser
			.parseOData({
				method: request.method,
				url: `/${request.vocabulary}${request.url}`,
			})
			.then(request => {
				const abstractSqlModel = getAbstractSqlModel(request);
				const resourceName = resolveSynonym(request);
				const resourceTable = abstractSqlModel.tables[resourceName];
				if (resourceTable == null) {
					throw new Error('Unknown resource: ' + request.resourceName);
				}
				const { idField } = resourceTable;

				_.set(request.odataQuery, ['options', '$select'], {
					properties: [{ name: idField }],
				});

				// Delete any $expand that might exist as they're ignored on non-GETs but we're converting this request to a GET
				delete request.odataQuery.options.$expand;

				return permissions.addPermissions(req, request).then(() => {
					request.method = 'GET';

					request = uriParser.translateUri(request);
					request = compileRequest(request);

					const doRunQuery = (tx: _db.Tx) =>
						runQuery(tx, request).then(result => _.map(result.rows, idField));
					if (tx != null) {
						return doRunQuery(tx);
					} else {
						return runTransaction(req, doRunQuery);
					}
				});
			});
	},
);

export const handleODataRequest: _express.Handler = (req, res, next) => {
	const [, apiRoot] = req.url.split('/');
	if (apiRoot == null || abstractSqlModels[apiRoot] == null) {
		return next('route');
	}

	if (process.env.DEBUG) {
		api[apiRoot].logger.log('Parsing', req.method, req.url);
	}

	const mapSeries = controlFlow.getMappingFn(req.headers);
	// Get the hooks for the current method/vocabulary as we know it,
	// in order to run PREPARSE hooks, before parsing gets us more info
	const reqHooks = (req.hooks = getHooks({
		method: req.method as SupportedMethod,
		vocabulary: apiRoot,
	}));

	req.on('close', () => {
		handlePromise.cancel();
		rollbackRequestHooks(reqHooks);
	});
	res.on('close', () => {
		handlePromise.cancel();
		rollbackRequestHooks(reqHooks);
	});

	if (req.tx != null) {
		req.tx.on('rollback', () => {
			rollbackRequestHooks(reqHooks);
		});
	}

	const handlePromise = runHooks('PREPARSE', { req, tx: req.tx })
		.then(() => {
			const { method, url, body } = req;

			let requests: uriParser.UnparsedRequest[];
			// Check if it is a single request or a batch
			if (req.batch != null && req.batch.length > 0) {
				requests = req.batch;
			} else {
				requests = [{ method: method, url: url, data: body }];
			}

			// Parse the OData requests
			return mapSeries(requests, requestPart =>
				uriParser
					.parseOData(requestPart)
					.then(
						controlFlow.liftP(request => {
							// Get the full hooks list now that we can. We clear the hooks on
							// the global req to avoid duplication
							req.hooks = {};
							request.hooks = getHooks(request);
							// Add/check the relevant permissions
							return runHooks('POSTPARSE', { req, request, tx: req.tx })
								.return(request)
								.then(uriParser.translateUri)
								.then(compileRequest)
								.tapCatch(() => {
									rollbackRequestHooks(req);
									rollbackRequestHooks(request);
								});
						}),
					)
					.then(request =>
						// Run the request in its own transaction
						runTransaction<Response | Response[]>(req, tx => {
							tx.on('rollback', () => {
								rollbackRequestHooks(req);
								rollbackRequestHooks(request);
							});
							if (_.isArray(request)) {
								const env = new Map<number, Response>();
								return Promise.reduce(
									request,
									runChangeSet(req, res, tx),
									env,
								).then(env => Array.from(env.values()));
							} else {
								return runRequest(req, res, tx, request);
							}
						}),
					),
			);
		})
		.then(results =>
			mapSeries(results, result => {
				if (_.isError(result)) {
					return constructError(result);
				} else {
					return result;
				}
			}),
		)
		.then(responses => {
			res.set('Cache-Control', 'no-cache');
			// If we are dealing with a single request unpack the response and respond normally
			if (req.batch == null || req.batch.length === 0) {
				const [{ body, headers, status }] = responses as Response[];
				if (status) {
					res.status(status);
				}
				_.forEach(headers, (headerValue, headerName) => {
					res.set(headerName, headerValue);
				});

				if (!body) {
					if (status != null) {
						res.sendStatus(status);
					} else {
						console.error('No status or body set', req.url, responses);
						res.sendStatus(500);
					}
				} else {
					if (status != null) {
						res.status(status);
					}
					res.json(body);
				}

				// Otherwise its a multipart request and we reply with the appropriate multipart response
			} else {
				(res.status(200) as any).sendMulti(responses);
			}
		})
		.catch((e: Error) => {
			// If an error bubbles here it must have happened in the last then block
			// We just respond with 500 as there is probably not much we can do to recover
			console.error(
				'An error occurred while constructing the response',
				e,
				e.stack,
			);
			res.sendStatus(500);
		});
	return handlePromise;
};

// Reject the error to use the nice catch syntax
const constructError = (
	err: any,
): { status: number; body?: string | AnyObject } => {
	if (err instanceof SbvrValidationError) {
		return { status: 400, body: err.message };
	} else if (err instanceof PermissionError)
		return { status: 401, body: err.message };
	else if (
		err instanceof SqlCompilationError ||
		err instanceof TranslationError ||
		err instanceof ParsingError ||
		err instanceof PermissionParsingError
	) {
		return { status: 500 };
	} else if (err instanceof UnsupportedMethodError) {
		return { status: 405, body: err.message };
	} else if (err instanceof HttpError) {
		return { status: err.status, body: err.getResponseBody() };
	} else {
		console.error(err);
		// If the err is an error object then use its message instead - it should be more readable!
		if (_.isError(err)) {
			err = err.message;
		}
		return { status: 404, body: err };
	}
};

const runRequest = (
	req: _express.Request,
	res: _express.Response,
	tx: _db.Tx,
	request: uriParser.ODataRequest,
): Promise<Response> => {
	const { logger } = api[request.vocabulary];

	if (process.env.DEBUG) {
		logger.log('Running', req.method, req.url);
	}
	// Forward each request to the correct method handler
	return runHooks('PRERUN', { req, request, tx })
		.then(
			(): Resolvable<_db.Result | number | undefined> => {
				switch (request.method) {
					case 'GET':
						return runGet(req, res, request, tx);
					case 'POST':
						return runPost(req, res, request, tx);
					case 'PUT':
					case 'PATCH':
					case 'MERGE':
						return runPut(req, res, request, tx);
					case 'DELETE':
						return runDelete(req, res, request, tx);
				}
			},
		)
		.catch(err => {
			if (err instanceof db.DatabaseError) {
				// This cannot be a `.tapCatch` because for some reason throwing a db.UniqueConstraintError doesn't override
				// the error, when usually throwing an error does.
				prettifyConstraintError(err, request.resourceName);
				logger.error(err);
				// Override the error message so we don't leak any internal db info
				err.message = 'Database error';
				throw err;
			}
			if (
				err instanceof uriParser.SyntaxError ||
				err instanceof EvalError ||
				err instanceof RangeError ||
				err instanceof ReferenceError ||
				err instanceof SyntaxError ||
				err instanceof TypeError ||
				err instanceof URIError
			) {
				logger.error(err);
				throw new InternalRequestError();
			}
			throw err;
		})
		.tap(result => {
			return runHooks('POSTRUN', { req, request, result, tx });
		})
		.then(result => {
			return prepareResponse(req, res, request, result, tx);
		});
};

const runChangeSet = (
	req: _express.Request,
	res: _express.Response,
	tx: _db.Tx,
) => (
	env: Map<number, Response>,
	request: uriParser.ODataRequest,
): Promise<Map<number, Response>> => {
	request = updateBinds(env, request);
	return runRequest(req, res, tx, request).then(result => {
		if (request.id == null) {
			throw new Error('No request id');
		}
		if (result.headers == null) {
			result.headers = {};
		}
		result.headers['Content-Id'] = request.id;
		env.set(request.id, result);
		return env;
	});
};

// Requests inside a changeset may refer to resources created inside the
// changeset, the generation of the sql query for those requests must be
// deferred untill the request they reference is run and returns an insert ID.
// This function compiles the sql query of a request which has been deferred
const updateBinds = (
	env: Map<number, Response>,
	request: uriParser.ODataRequest,
) => {
	if (request._defer) {
		request.odataBinds = _.map(request.odataBinds, ([tag, id]) => {
			if (tag == 'ContentReference') {
				const ref = env.get(id);
				if (ref == null || ref.body == null || ref.body.id === undefined) {
					throw new BadRequestError(
						'Reference to a non existing resource in Changeset',
					);
				}
				return uriParser.parseId(ref.body.id);
			}
			return [tag, id];
		});
	}
	return request;
};

const prepareResponse = (
	req: _express.Request,
	res: _express.Response,
	request: uriParser.ODataRequest,
	result: any,
	tx: _db.Tx,
): Promise<Response> => {
	switch (request.method) {
		case 'GET':
			return respondGet(req, res, request, result, tx);
		case 'POST':
			return respondPost(req, res, request, result, tx);
		case 'PUT':
		case 'PATCH':
		case 'MERGE':
			return respondPut(req, res, request, result, tx);
		case 'DELETE':
			return respondDelete(req, res, request, result, tx);
		case 'OPTIONS':
			return respondOptions(req, res, request, result, tx);
		default:
			return Promise.reject(new UnsupportedMethodError());
	}
};

// This is a helper method to handle using a passed in req.tx when available, or otherwise creating a new tx and cleaning up after we're done.
const runTransaction = <T>(
	req: HookReq,
	callback: (tx: _db.Tx) => Promise<T>,
): Promise<T> => {
	if (req.tx != null) {
		// If an existing tx was passed in then use it.
		return callback(req.tx);
	} else {
		// Otherwise create a new transaction and handle tidying it up.
		return db.transaction(callback);
	}
};

// This is a helper function that will check and add the bind values to the SQL query and then run it.
const runQuery = (
	tx: _db.Tx,
	request: uriParser.ODataRequest,
	queryIndex?: number,
	addReturning?: string,
): Promise<_db.Result> => {
	const { values, odataBinds, vocabulary } = request;
	let { sqlQuery } = request;
	if (sqlQuery == null) {
		return Promise.reject('No SQL query available to run');
	}
	if (_.isArray(sqlQuery)) {
		if (queryIndex == null) {
			return Promise.reject(
				'Received a query index to run but the query is not an array',
			);
		}
		sqlQuery = sqlQuery[queryIndex];
	}

	const { query, bindings } = sqlQuery;
	return getAndCheckBindValues(vocabulary, odataBinds, bindings, values).then(
		values => {
			if (DEBUG) {
				api[vocabulary].logger.log(query, values);
			}

			return tx.executeSql(query, values, addReturning);
		},
	);
};

const runGet = (
	_req: _express.Request,
	_res: _express.Response,
	request: uriParser.ODataRequest,
	tx: _db.Tx,
) => {
	if (request.sqlQuery != null) {
		return runQuery(tx, request);
	}
};

const respondGet = (
	req: _express.Request,
	res: _express.Response,
	request: uriParser.ODataRequest,
	result: any,
	tx: _db.Tx,
) => {
	const vocab = request.vocabulary;
	if (request.sqlQuery != null) {
		return processOData(
			vocab,
			getAbstractSqlModel(request),
			request.resourceName,
			result.rows,
		).then(d => {
			return runHooks('PRERESPOND', {
				req,
				res,
				request,
				result,
				data: { d },
				tx: tx,
			}).then(() => {
				return { body: { d }, headers: { contentType: 'application/json' } };
			});
		});
	} else {
		if (request.resourceName === '$metadata') {
			return Promise.resolve({
				body: odataMetadata[vocab],
				headers: { contentType: 'xml' },
			});
		} else {
			// TODO: request.resourceName can be '$serviceroot' or a resource and we should return an odata xml document based on that
			return Promise.resolve({
				status: 404,
			});
		}
	}
};

const runPost = (
	_req: _express.Request,
	_res: _express.Response,
	request: uriParser.ODataRequest,
	tx: _db.Tx,
) => {
	const vocab = request.vocabulary;

	const idField = getAbstractSqlModel(request).tables[resolveSynonym(request)]
		.idField;

	return runQuery(tx, request, undefined, idField)
		.tap(sqlResult => {
			if (sqlResult.rowsAffected === 0) {
				throw new PermissionError();
			}
			return validateModel(tx, vocab, request);
		})
		.then(({ insertId }) => insertId);
};

const respondPost = (
	req: _express.Request,
	res: _express.Response,
	request: uriParser.ODataRequest,
	id: number,
	tx: _db.Tx,
) => {
	const vocab = request.vocabulary;
	const location = odataResourceURI(vocab, request.resourceName, id);
	if (DEBUG) {
		api[vocab].logger.log('Insert ID: ', request.resourceName, id);
	}
	return Promise.try(() => {
		const onlyId = { d: [{ id }] };
		if (
			_.includes(
				['0', 'false'],
				_.get(request, ['odataQuery', 'options', 'returnResource']),
			)
		) {
			return onlyId;
		}
		return (
			runURI('GET', location, undefined, tx, req)
				// If we failed to fetch the created resource then just return the id.
				.catchReturn(onlyId)
		);
	}).then((result: AnyObject) => {
		return runHooks('PRERESPOND', { req, res, request, result, tx }).return({
			status: 201,
			body: result.d[0],
			headers: {
				contentType: 'application/json',
				Location: location,
			},
		});
	});
};

const runPut = (
	_req: _express.Request,
	_res: _express.Response,
	request: uriParser.ODataRequest,
	tx: _db.Tx,
) => {
	const vocab = request.vocabulary;

	return Promise.try(() => {
		// If request.sqlQuery is an array it means it's an UPSERT, ie two queries: [InsertQuery, UpdateQuery]
		if (_.isArray(request.sqlQuery)) {
			// Run the update query first
			return runQuery(tx, request, 1).then(result => {
				if (result.rowsAffected === 0) {
					// Then run the insert query if nothing was updated
					return runQuery(tx, request, 0);
				}
				return result;
			});
		} else {
			return runQuery(tx, request);
		}
	})
		.then(() => {
			return validateModel(tx, vocab, request);
		})
		.return(undefined);
};

const respondPut = (
	req: _express.Request,
	res: _express.Response,
	request: uriParser.ODataRequest,
	_result: any,
	tx: _db.Tx,
) => {
	return runHooks('PRERESPOND', { req, res, request, tx: tx }).return({
		status: 200,
		headers: {},
	});
};
const respondDelete = respondPut;
const respondOptions = respondPut;

const runDelete = (
	_req: _express.Request,
	_res: _express.Response,
	request: uriParser.ODataRequest,
	tx: _db.Tx,
) => {
	const vocab = request.vocabulary;

	return runQuery(tx, request)
		.then(() => {
			return validateModel(tx, vocab, request);
		})
		.return(undefined);
};

export const executeStandardModels = (
	tx: _db.Tx,
	callback?: (err?: Error) => void,
): Promise<void> => {
	// dev model must run first
	return executeModel(tx, {
		apiRoot: 'dev',
		modelText: devModel,
		logging: {
			log: false,
		},
	})
		.then(() => {
			return executeModels(tx, permissions.config.models);
		})
		.then(() => {
			console.info('Successfully executed standard models.');
		})
		.tapCatch((err: Error) => {
			console.error('Failed to execute standard models.', err);
		})
		.nodeify(callback);
};

export const addSideEffectHook = (
	method: HookMethod,
	apiRoot: string,
	resourceName: string,
	hooks: Hooks,
): void => {
	const sideEffectHook = _.mapValues(hooks, hook => {
		if (hook != null) {
			return {
				HOOK: hook,
				effects: true,
			};
		}
	});
	addHook(method, apiRoot, resourceName, sideEffectHook);
};

export const addPureHook = (
	method: HookMethod,
	apiRoot: string,
	resourceName: string,
	hooks: Hooks,
): void => {
	const pureHooks = _.mapValues(hooks, hook => {
		if (hook != null) {
			return {
				HOOK: hook,
				effects: false,
			};
		}
	});
	addHook(method, apiRoot, resourceName, pureHooks);
};

const addHook = (
	method: keyof typeof apiHooks,
	apiRoot: string,
	resourceName: string,
	hooks: {
		[key in keyof Hooks]: HookBlueprint<Parameters<NonNullable<Hooks[key]>>>
	},
) => {
	const methodHooks = apiHooks[method];
	if (methodHooks == null) {
		throw new Error('Unsupported method: ' + method);
	}
	if (apiRoot !== 'all' && abstractSqlModels[apiRoot] == null) {
		throw new Error('Unknown api root: ' + apiRoot);
	}
	if (resourceName !== 'all') {
		const origResourceName = resourceName;
		resourceName = resolveSynonym({ vocabulary: apiRoot, resourceName });
		if (abstractSqlModels[apiRoot].tables[resourceName] == null) {
			throw new Error(
				'Unknown resource for api root: ' + origResourceName + ', ' + apiRoot,
			);
		}
	}

	if (methodHooks[apiRoot] == null) {
		methodHooks[apiRoot] = {};
	}
	const apiRootHooks = methodHooks[apiRoot];
	if (apiRootHooks[resourceName] == null) {
		apiRootHooks[resourceName] = {};
	}

	const resourceHooks = apiRootHooks[resourceName];

	for (const hookType in hooks) {
		if (!isValidHook(hookType)) {
			throw new Error('Unknown callback type: ' + hookType);
		}
		const hook = hooks[hookType];
		if (resourceHooks[hookType] == null) {
			resourceHooks[hookType] = [];
		}
		if (hook != null) {
			resourceHooks[hookType]!.push(hook);
		}
	}

	getHooks.clear();
};

export const setup = (
	_app: _express.Application,
	_db: _db.Database,
	callback?: (err?: Error) => void,
): Promise<void> => {
	exports.db = db = _db;
	abstractSQLCompiler = AbstractSQLCompiler[db.engine];
	return db
		.transaction(tx =>
			executeStandardModels(tx).then(() => {
				permissions.setup();
			}),
		)
		.catch(err => {
			console.error('Could not execute standard models', err);
			process.exit(1);
		})
		.then(
			() =>
				db
					.executeSql(
						'CREATE UNIQUE INDEX "uniq_model_model_type_vocab" ON "model" ("is of-vocabulary", "model type");',
					)
					.catch(_.noop), // we can't use IF NOT EXISTS on all dbs, so we have to ignore the error raised if this index already exists
		)
		.return()
		.nodeify(callback);
};