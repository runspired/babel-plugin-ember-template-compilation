'use strict';
const { replaceTemplateLiteralProposal } = require('./src/template-literal-transform');

module.exports = function (babel) {
  let t = babel.types;

  const runtimeErrorIIFE = babel.template(
    `(function() {\n  throw new Error('ERROR_MESSAGE');\n})();`
  );

  function parseExpression(buildError, name, node) {
    switch (node.type) {
      case 'ObjectExpression':
        return parseObjectExpression(buildError, name, node);
      case 'ArrayExpression': {
        return parseArrayExpression(buildError, name, node);
      }
      case 'StringLiteral':
      case 'BooleanLiteral':
      case 'NumericLiteral':
        return node.value;
      default:
        throw buildError(
          `${name} can only accept static options but you passed ${JSON.stringify(node)}`
        );
    }
  }

  function parseArrayExpression(buildError, name, node) {
    let result = node.elements.map((element) => parseExpression(buildError, name, element));

    return result;
  }

  function parseScopeObject(buildError, name, node) {
    if (node.type !== 'ObjectExpression') {
      throw buildError(
        `Scope objects for \`${name}\` must be an object expression containing only references to in-scope values`
      );
    }

    return node.properties.map((prop) => {
      let { key, value } = prop;

      if (value.type !== 'Identifier' || value.name !== key.name) {
        throw buildError(
          `Scope objects for \`${name}\` may only contain direct references to in-scope values, e.g. { ${key.name} } or { ${key.name}: ${key.name} }`
        );
      }

      return key.name;
    });
  }

  function parseObjectExpression(buildError, name, node, shouldParseScope = false) {
    let result = {};

    node.properties.forEach((property) => {
      if (property.computed || !['Identifier', 'StringLiteral'].includes(property.key.type)) {
        throw buildError(`${name} can only accept static options`);
      }

      let propertyName =
        property.key.type === 'Identifier' ? property.key.name : property.key.value;

      let value;

      if (shouldParseScope && propertyName === 'scope') {
        value = parseScopeObject(buildError, name, property.value);
      } else {
        value = parseExpression(buildError, name, property.value);
      }

      result[propertyName] = value;
    });

    return result;
  }

  function compileTemplate(precompile, template, emberIdentifier, _options) {
    let options = Object.assign({ contents: template }, _options);

    let precompileResultString;

    if (options.insertRuntimeErrors) {
      try {
        precompileResultString = precompile(template, options);
      } catch (error) {
        return runtimeErrorIIFE({ ERROR_MESSAGE: error.message });
      }
    } else {
      precompileResultString = precompile(template, options);
    }

    let precompileResultAST = babel.parse(`var precompileResult = ${precompileResultString};`);

    let templateExpression = precompileResultAST.program.body[0].declarations[0].init;

    t.addComment(
      templateExpression,
      'leading',
      `\n  ${template.replace(/\*\//g, '*\\/')}\n`,
      /* line comment? */ false
    );

    return t.callExpression(
      t.memberExpression(
        t.memberExpression(emberIdentifier, t.identifier('HTMLBars')),
        t.identifier('template')
      ),
      [templateExpression]
    );
  }

  function getScope(scope) {
    let names = [];

    while (scope) {
      for (let binding in scope.bindings) {
        names.push(binding);
      }

      scope = scope.parent;
    }

    return names;
  }

  function replacePath(path, state, compiled, options) {
    if (options.useTemplateLiteralProposalSemantics) {
      replaceTemplateLiteralProposal(t, path, state, compiled, options);
    } else {
      path.replaceWith(compiled);
    }
  }

  let visitor = {
    Program(path, state) {
      let options = state.opts || {};

      // Find/setup Ember global identifier
      let useEmberModule = Boolean(options.useEmberModule);
      let allAddedImports = {};

      state.ensureImport = (exportName, moduleName) => {
        let addedImports = (allAddedImports[moduleName] = allAddedImports[moduleName] || {});

        if (addedImports[exportName]) return addedImports[exportName];

        if (exportName === 'default' && moduleName === 'ember' && !useEmberModule) {
          addedImports[exportName] = t.identifier('Ember');
          return addedImports[exportName];
        }

        let importDeclarations = path.get('body').filter((n) => n.type === 'ImportDeclaration');

        let preexistingImportDeclaration = importDeclarations.find(
          (n) => n.get('source').get('value').node === moduleName
        );

        if (preexistingImportDeclaration) {
          let importSpecifier = preexistingImportDeclaration.get('specifiers').find(({ node }) => {
            return exportName === 'default'
              ? t.isImportDefaultSpecifier(node)
              : node.imported.name === exportName;
          });

          if (importSpecifier) {
            addedImports[exportName] = importSpecifier.node.local;
          }
        }

        if (!addedImports[exportName]) {
          let uid = path.scope.generateUidIdentifier(
            exportName === 'default' ? moduleName : exportName
          );
          addedImports[exportName] = uid;

          let newImportSpecifier =
            exportName === 'default'
              ? t.importDefaultSpecifier(uid)
              : t.importSpecifier(uid, t.identifier(exportName));

          let newImport = t.importDeclaration([newImportSpecifier], t.stringLiteral(moduleName));
          path.unshiftContainer('body', newImport);
        }

        return addedImports[exportName];
      };

      // Setup other module options and create cache for values
      let modules = state.opts.modules || {
        'htmlbars-inline-precompile': { export: 'default', shouldParseScope: false },
      };

      if (state.opts.modulePaths) {
        let modulePaths = state.opts.modulePaths;

        modulePaths.forEach((path) => (modules[path] = { export: 'default' }));
      }

      let presentModules = new Map();
      let importDeclarations = path.get('body').filter((n) => n.type === 'ImportDeclaration');

      for (let module in modules) {
        let paths = importDeclarations.filter(
          (path) => !path.removed && path.get('source').get('value').node === module
        );

        for (let path of paths) {
          let options = modules[module];

          if (typeof options === 'string') {
            // Normalize 'moduleName': 'importSpecifier'
            options = { export: options };
          } else {
            // else clone options so we don't mutate it
            options = Object.assign({}, options);
          }

          let modulePathExport = options.export;
          let importSpecifierPath = path
            .get('specifiers')
            .find(({ node }) =>
              modulePathExport === 'default'
                ? t.isImportDefaultSpecifier(node)
                : node.imported && node.imported.name === modulePathExport
            );

          if (importSpecifierPath) {
            let localName = importSpecifierPath.node.local.name;

            options.modulePath = module;
            options.originalName = localName;
            let localImportId = path.scope.generateUidIdentifierBasedOnNode(path.node.id);

            path.scope.rename(localName, localImportId);

            // If it was the only specifier, remove the whole import, else
            // remove the specifier
            if (path.node.specifiers.length === 1) {
              path.remove();
            } else {
              importSpecifierPath.remove();
            }

            presentModules.set(localImportId, options);
          }
        }
      }

      state.presentModules = presentModules;
    },

    ClassDeclaration(path, state) {
      // Processing classes this way allows us to process ClassProperty nodes
      // before other transforms, such as the class-properties transform
      path.get('body.body').forEach((path) => {
        if (path.type !== 'ClassProperty') return;

        let keyPath = path.get('key');
        let valuePath = path.get('value');

        if (keyPath && visitor[keyPath.type]) {
          visitor[keyPath.type](keyPath, state);
        }

        if (valuePath && visitor[valuePath.type]) {
          visitor[valuePath.type](valuePath, state);
        }
      });
    },

    TaggedTemplateExpression(path, state) {
      let tagPath = path.get('tag');
      let options = state.presentModules.get(tagPath.node.name);

      if (!options) {
        return;
      }

      if (options.disableTemplateLiteral) {
        throw path.buildCodeFrameError(
          `Attempted to use \`${options.originalName}\` as a template tag, but it can only be called as a function with a string passed to it: ${options.originalName}('content here')`
        );
      }

      if (path.node.quasi.expressions.length) {
        throw path.buildCodeFrameError(
          'placeholders inside a tagged template string are not supported'
        );
      }

      let template = path.node.quasi.quasis.map((quasi) => quasi.value.cooked).join('');

      let { precompile, isProduction } = state.opts;
      let scope = options.useTemplateLiteralProposalSemantics ? getScope(path.scope) : null;
      let strict = Boolean(options.useTemplateLiteralProposalSemantics);

      let emberIdentifier = state.ensureImport('default', 'ember');

      replacePath(
        path,
        state,
        compileTemplate(precompile, template, emberIdentifier, { isProduction, scope, strict }),
        options
      );
    },

    CallExpression(path, state) {
      let calleePath = path.get('callee');
      let options = state.presentModules.get(calleePath.node.name);

      if (!options) {
        return;
      }

      if (options.disableFunctionCall) {
        throw path.buildCodeFrameError(
          `Attempted to use \`${options.originalName}\` as a function call, but it can only be used as a template tag: ${options.originalName}\`content here\``
        );
      }

      let args = path.node.arguments;

      let template;

      switch (args[0] && args[0].type) {
        case 'StringLiteral':
          template = args[0].value;
          break;
        case 'TemplateLiteral':
          if (args[0].expressions.length) {
            throw path.buildCodeFrameError(
              'placeholders inside a template string are not supported'
            );
          } else {
            template = args[0].quasis.map((quasi) => quasi.value.cooked).join('');
          }
          break;
        case 'TaggedTemplateExpression':
          throw path.buildCodeFrameError(
            `tagged template strings inside ${options.originalName} are not supported`
          );
        default:
          throw path.buildCodeFrameError(
            'hbs should be invoked with at least a single argument: the template string'
          );
      }

      let compilerOptions;

      switch (args.length) {
        case 1:
          compilerOptions = {};
          break;
        case 2: {
          if (args[1].type !== 'ObjectExpression') {
            throw path.buildCodeFrameError(
              'hbs can only be invoked with 2 arguments: the template string, and any static options'
            );
          }

          compilerOptions = parseObjectExpression(
            path.buildCodeFrameError.bind(path),
            options.originalName,
            args[1],
            true
          );

          break;
        }
        default:
          throw path.buildCodeFrameError(
            'hbs can only be invoked with 2 arguments: the template string, and any static options'
          );
      }

      let { precompile, isProduction } = state.opts;

      // allow the user specified value to "win" over ours
      if (!('isProduction' in compilerOptions)) {
        compilerOptions.isProduction = isProduction;
      }

      replacePath(
        path,
        state,
        compileTemplate(
          precompile,
          template,
          state.ensureImport('default', 'ember'),
          compilerOptions
        ),
        options
      );
    },
  };

  return { visitor };
};

module.exports._parallelBabel = {
  requireFile: __filename,
};

module.exports.baseDir = function () {
  return __dirname;
};
