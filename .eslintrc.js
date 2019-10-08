const os = require('os');

module.exports = {
    "env": {
        "browser": true,
        "es6": true,
        "node": true
    },
    "extends": ["eslint:recommended", "google"],
    "rules": {
        "arrow-parens": [
            "error",
            "as-needed"
        ],
        "brace-style": [
            "error",
            "1tbs",
            { "allowSingleLine": true }
        ],
        "comma-dangle": [
            "error",
            "never"
        ],
        "indent": [
            "error",
            4,
            {
                "outerIIFEBody": 0
            }
        ],
        "linebreak-style": [
            "error",
            (os.platform() === 'win32' ? "windows" : "unix")
        ],
        "no-prototype-builtins": [
            "error"
        ],
        "quotes": [
            "error",
            "single",
            { "avoidEscape": true }
        ],
        "require-jsdoc": [
            "off"
        ]
    }
};
