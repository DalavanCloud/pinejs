import * as _ from 'lodash';
import * as sbvrTypes from '@resin/sbvr-types';
import { SqlModel, AbstractSqlTable } from '@resin/abstract-sql-compiler';

// tslint:disable-next-line:no-var-requires
const { version }: { version: string } = require('../../package.json');

const getResourceName = (resourceName: string): string =>
	resourceName
		.split('-')
		.map(namePart => namePart.split(' ').join('_'))
		.join('__');

const forEachUniqueTable = <T>(
	model: SqlModel['tables'],
	callback: (tableName: string, table: AbstractSqlTable) => T,
): T[] => {
	const usedTableNames: _.Dictionary<true> = {};

	const result = [];
	for (const key in model) {
		const table = model[key];
		if (!_.isString(table) && !table.primitive && !usedTableNames[table.name]) {
			usedTableNames[table.name] = true;
			result.push(callback(key, table));
		}
	}
	return result;
};

const odataMetadataGenerator = (vocabulary: string, sqlModel: SqlModel) => {
	const complexTypes: _.Dictionary<string> = {};
	const resolveDataType = (fieldType: string): string => {
		if (sbvrTypes[fieldType] == null) {
			console.error('Could not resolve type', fieldType);
			throw new Error('Could not resolve type' + fieldType);
		}
		const { complexType } = sbvrTypes[fieldType].types.odata;
		if (complexType != null) {
			complexTypes[fieldType] = complexType;
		}
		return sbvrTypes[fieldType].types.odata.name;
	};

	const model = sqlModel.tables;
	const associations: Array<{
		name: string;
		ends: Array<{
			resourceName: string;
			cardinality: '1' | '0..1' | '*';
		}>;
	}> = [];
	forEachUniqueTable(model, (_key, { name: resourceName, fields }) => {
		resourceName = getResourceName(resourceName);
		for (const { dataType, required, references } of fields) {
			if (dataType === 'ForeignKey' && references != null) {
				const { resourceName: referencedResource } = references;
				associations.push({
					name: resourceName + referencedResource,
					ends: [
						{ resourceName, cardinality: required ? '1' : '0..1' },
						{ resourceName: referencedResource, cardinality: '*' },
					],
				});
			}
		}
	});

	return (
		`
		<?xml version="1.0" encoding="iso-8859-1" standalone="yes"?>
		<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx">
			<edmx:DataServices xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" m:DataServiceVersion="2.0">
				<Schema Namespace="${vocabulary}"
					xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices"
					xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"
					xmlns="http://schemas.microsoft.com/ado/2008/09/edm">

				` +
		forEachUniqueTable(
			model,
			(_key, { idField, name: resourceName, fields }) => {
				resourceName = getResourceName(resourceName);
				return (
					`
					<EntityType Name="${resourceName}">
						<Key>
							<PropertyRef Name="${idField}" />
						</Key>

						` +
					fields
						.filter(({ dataType }) => dataType !== 'ForeignKey')
						.map(({ dataType, fieldName, required }) => {
							dataType = resolveDataType(dataType);
							fieldName = getResourceName(fieldName);
							return `<Property Name="${fieldName}" Type="${dataType}" Nullable="${!required}" />`;
						})
						.join('\n') +
					'\n' +
					fields
						.filter(
							({ dataType, references }) =>
								dataType === 'ForeignKey' && references != null,
						)
						.map(({ fieldName, references }) => {
							const { resourceName: referencedResource } = references!;
							fieldName = getResourceName(fieldName);
							return `<NavigationProperty Name="${fieldName}" Relationship="${vocabulary}.${resourceName +
								referencedResource}" FromRole="${resourceName}" ToRole="${referencedResource}" />`;
						})
						.join('\n') +
					'\n' +
					`
					</EntityType>`
				);
			},
		).join('\n\n') +
		associations
			.map(({ name, ends }) => {
				name = getResourceName(name);
				return (
					`<Association Name="${name}">` +
					'\n\t' +
					ends
						.map(
							({ resourceName, cardinality }) =>
								`<End Role="${resourceName}" Type="${vocabulary}.${resourceName}" Multiplicity="${cardinality}" />`,
						)
						.join('\n\t') +
					'\n' +
					`</Association>`
				);
			})
			.join('\n') +
		`
					<EntityContainer Name="${vocabulary}Service" m:IsDefaultEntityContainer="true">

					` +
		forEachUniqueTable(model, (_key, { name: resourceName }) => {
			resourceName = getResourceName(resourceName);
			return `<EntitySet Name="${resourceName}" EntityType="${vocabulary}.${resourceName}" />`;
		}).join('\n') +
		'\n' +
		associations
			.map(({ name, ends }) => {
				name = getResourceName(name);
				return (
					`<AssociationSet Name="${name}" Association="${vocabulary}.${name}">` +
					'\n\t' +
					ends
						.map(
							({ resourceName }) =>
								`<End Role="${resourceName}" EntitySet="${vocabulary}.${resourceName}" />`,
						)
						.join('\n\t') +
					`
								</AssociationSet>`
				);
			})
			.join('\n') +
		`
					</EntityContainer>` +
		_.values(complexTypes).join('\n') +
		`
				</Schema>
			</edmx:DataServices>
		</edmx:Edmx>`
	);
};

odataMetadataGenerator.version = version;
export = odataMetadataGenerator;
