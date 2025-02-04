import {
	Tree,
	formatFiles,
	getProjects,
	logger,
	readJson,
	readProjectConfiguration,
	visitNotIgnoredFiles,
} from '@nx/devkit';
import { readFileSync } from 'node:fs';
import { exit } from 'node:process';
import {
	CodeBlockWriter,
	Decorator,
	Node,
	Project,
	WriterFunction,
} from 'ts-morph';
import { ConvertOutputsGeneratorSchema } from './schema';

class ContentsStore {
	private _project: Project = null!;

	collection: Array<{ path: string; content: string }> = [];

	get project() {
		if (!this._project) {
			this._project = new Project({ useInMemoryFileSystem: true });
		}

		return this._project;
	}

	track(path: string, content: string) {
		this.collection.push({ path, content });
		this.project.createSourceFile(path, content);
	}
}

function trackContents(
	tree: Tree,
	contentsStore: ContentsStore,
	fullPath: string,
) {
	if (fullPath.endsWith('.ts')) {
		const fileContent =
			tree.read(fullPath, 'utf8') || readFileSync(fullPath, 'utf8');
		if (
			!fileContent.includes('@Component') &&
			!fileContent.includes('@Directive')
		) {
			logger.log(
				`[ngxtension] "${fullPath}" is not a Component nor a Directive`,
			);
			return;
		}

		if (fileContent.includes('@Output')) {
			contentsStore.track(fullPath, fileContent);
		}
	}
}

function getOutputInitializer(
	propertyName: string,
	decorator: Decorator,
	initializer: string,
): {
	outputName?: string;
	needsOutputFromObservableImport: boolean;
	removeOnlyDecorator?: boolean;
	writerFn: WriterFunction;
} {
	const decoratorArg = decorator.getArguments()[0];

	// get alias if there is any from the decorator
	let alias: string | undefined = undefined;
	if (Node.isStringLiteral(decoratorArg)) {
		alias = decoratorArg.getText();
	}

	// check if the initializer is not an EventEmitter -> means its an observable
	if (!initializer.includes('EventEmitter')) {
		// if the initializer is a Subject or BehaviorSubject
		if (
			initializer.includes('Subject') ||
			initializer.includes('BehaviorSubject')
		) {
			// Before: @Output() outputFromSubject = new Subject();
			// After: _outputFromSubject = outputFromObservable(this.outputFromSubject, { alias: 'outputFromSubject' });

			return {
				writerFn: (writer: CodeBlockWriter) => {
					writer.write(`outputFromObservable`);
					writer.write(`(this.${propertyName}`);
					writer.write(`, { alias: ${alias ?? `'${propertyName}'`} }`);
					writer.write(`);`);
				},
				outputName: `_${propertyName}`,
				removeOnlyDecorator: true,
				needsOutputFromObservableImport: true,
			};
		} else {
			return {
				writerFn: (writer: CodeBlockWriter) => {
					writer.write(`outputFromObservable`);
					writer.write(`(${initializer}`);
					writer.write(`${alias ? `, { alias: ${alias} }` : ''}`);
					writer.write(`);`);
				},
				needsOutputFromObservableImport: true,
			};
		}
	} else {
		let type = '';
		if (initializer.includes('EventEmitter()')) {
			// there is no type
		} else {
			const genericTypeOnEmitter = initializer.match(/EventEmitter<(.+)>/);
			if (genericTypeOnEmitter?.length) {
				type = genericTypeOnEmitter[1];
			}
		}

		return {
			writerFn: (writer: CodeBlockWriter) => {
				writer.write(`output`);
				writer.write(`${type ? `<${type}>` : ''}(`);
				writer.write(`${alias ? `, { alias: ${alias} }` : ''}`);
				writer.write(`);`);
			},
			needsOutputFromObservableImport: false,
		};
	}
}

export async function convertOutputsGenerator(
	tree: Tree,
	options: ConvertOutputsGeneratorSchema,
) {
	const contentsStore = new ContentsStore();
	const packageJson = readJson(tree, 'package.json');
	const angularCorePackage = packageJson['dependencies']['@angular/core'];

	if (!angularCorePackage) {
		logger.error(`[ngxtension] No @angular/core detected`);
		return exit(1);
	}

	const [major, minor] = angularCorePackage
		.split('.')
		.slice(0, 2)
		.map((part: string) => {
			if (part.startsWith('^') || part.startsWith('~')) {
				return Number(part.slice(1));
			}
			return Number(part);
		});

	if (major < 17 || (major >= 17 && minor < 3)) {
		logger.error(`[ngxtension] output() is only available in v17.3 and later`);
		return exit(1);
	}

	const { path, project } = options;

	if (path && project) {
		logger.error(
			`[ngxtension] Cannot pass both "path" and "project" to convertOutputsGenerator`,
		);
		return exit(1);
	}

	if (path) {
		if (!tree.exists(path)) {
			logger.error(`[ngxtension] "${path}" does not exist`);
			return exit(1);
		}

		trackContents(tree, contentsStore, path);
	} else if (project) {
		try {
			const projectConfiguration = readProjectConfiguration(tree, project);

			if (!projectConfiguration) {
				throw `"${project}" project not found`;
			}

			visitNotIgnoredFiles(tree, projectConfiguration.root, (path) => {
				trackContents(tree, contentsStore, path);
			});
		} catch (err) {
			logger.error(`[ngxtension] ${err}`);
			return;
		}
	} else {
		const projects = getProjects(tree);
		for (const project of projects.values()) {
			visitNotIgnoredFiles(tree, project.root, (path) => {
				trackContents(tree, contentsStore, path);
			});
		}
	}

	for (const { path: sourcePath } of contentsStore.collection) {
		const sourceFile = contentsStore.project.getSourceFile(sourcePath)!;

		const hasOutputImport = sourceFile.getImportDeclaration(
			(importDecl) =>
				importDecl.getModuleSpecifierValue() === '@angular/core' &&
				importDecl
					.getNamedImports()
					.some((namedImport) => namedImport.getName() === 'output'),
		);

		// NOTE: only add hasOutputImport import if we don't have it and we find the first Output decorator
		if (!hasOutputImport) {
			sourceFile.addImportDeclaration({
				namedImports: ['output'],
				moduleSpecifier: '@angular/core',
			});
		}

		const classes = sourceFile.getClasses();

		for (const targetClass of classes) {
			const applicableDecorator = targetClass.getDecorator((decoratorDecl) => {
				return ['Component', 'Directive'].includes(decoratorDecl.getName());
			});
			if (!applicableDecorator) continue;

			const convertedOutputs = new Set<string>();

			let outputFromObservableImportAdded = false;

			targetClass.forEachChild((node) => {
				if (Node.isPropertyDeclaration(node)) {
					const outputDecorator = node.getDecorator('Output');
					if (outputDecorator) {
						const {
							name,
							isReadonly,
							docs,
							scope,
							hasOverrideKeyword,
							initializer,
						} = node.getStructure();

						const {
							needsOutputFromObservableImport,
							removeOnlyDecorator,
							outputName,
							writerFn,
						} = getOutputInitializer(
							name,
							outputDecorator,
							initializer as string,
						);

						if (
							needsOutputFromObservableImport &&
							!outputFromObservableImportAdded
						) {
							sourceFile.addImportDeclaration({
								namedImports: ['outputFromObservable'],
								moduleSpecifier: '@angular/core/rxjs-interop',
							});
							outputFromObservableImportAdded = true;
						}

						const newProperty = targetClass.addProperty({
							name: outputName ?? name,
							isReadonly,
							docs,
							scope,
							hasOverrideKeyword,
							initializer: writerFn,
						});

						if (removeOnlyDecorator) {
							outputDecorator.remove();

							newProperty.setHasExclamationToken(false);

							newProperty.addJsDoc(
								'TODO(migration): you may want to convert this to a normal output',
							);
						} else {
							node.replaceWithText(newProperty.print());
							// remove old class property Output
							newProperty.remove();
						}

						// track converted outputs
						convertedOutputs.add(name);
					}
				}
			});
		}

		tree.write(sourcePath, sourceFile.getFullText());
	}

	await formatFiles(tree);

	logger.info(
		`
[ngxtension] Conversion completed. Please check the content and run your formatter as needed.
`,
	);
}

export default convertOutputsGenerator;
