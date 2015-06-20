"use strict";

var base = require("xbase"),
	fs = require("fs"),
	path = require("path"),
	runUtil = require("xutil").run,
	fileUtil = require("xutil").file,
	moment = require("moment"),
	jsen = require("jsen"),
	jsonselect = require("JSONSelect"),
	libxmljs = require("libxmljs"),
	C = require("C"),
	PEG = require("pegjs"),
	rimraf = require("rimraf"),
	tiptoe = require("tiptoe");

if(process.argv.length<3 || !fs.existsSync(process.argv[2]))
{
	base.error("Usage: node generate.js /path/to/hots");
	process.exit(1);
}

var HOTS_PATH = process.argv[2];
var HOTS_DATA_PATH = path.join(HOTS_PATH, "HeroesData");

if(!fs.existsSync(HOTS_DATA_PATH))
{
	base.error("HeroesData dir not found: %s", HOTS_DATA_PATH);
	process.exit(1);
}

var CASCEXTRATOR_PATH = path.join(__dirname, "CASCExtractor", "build", "bin", "CASCExtractor");

var OUT_PATH = path.join(__dirname, "out");
var HEROES_OUT_PATH = path.join(OUT_PATH, "heroes.json");

var EXTRA_HEROES = ["anubarak", "chen", "crusader", "jaina", "kaelthas", "lostvikings", "murky", "sonyarework", "sylvanas", "thrall"];
var NEEDED_SUBFIXES =
[
	"enus.stormdata\\LocalizedData\\GameStrings.txt",
	"base.stormdata\\GameData\\BehaviorData.xml",
	"base.stormdata\\GameData\\TalentData.xml",
	"base.stormdata\\GameData\\AbilData.xml",
	"base.stormdata\\GameData\\EffectData.xml",
	"base.stormdata\\GameData\\HeroData.xml",
];

var NEEDED_PREFIXES = ["heroesdata.stormmod"];
EXTRA_HEROES.forEach(function(EXTRA_HERO)
{
	NEEDED_PREFIXES.push("heromods\\" + EXTRA_HERO + ".stormmod");
});

var NEEDED_FILE_PATHS = [];

NEEDED_PREFIXES.forEach(function(NEEDED_PREFIX)
{
	NEEDED_SUBFIXES.forEach(function(NEEDED_SUBFIX)
	{
		NEEDED_FILE_PATHS.push("mods\\" + NEEDED_PREFIX + "\\" + NEEDED_SUBFIX);
	});
});

NEEDED_FILE_PATHS.push("mods\\heroesdata.stormmod\\base.stormdata\\GameData\\Heroes\\ZagaraData.xml");

var FORMULA_PARSER = PEG.buildParser(fs.readFileSync(path.join(__dirname, "heroes.pegjs"), {encoding:"utf8"}));

var S = {};
var NODE_MAP_TYPES = ["Hero", "Talent", "Behavior", "Effect", "Abil" ];
var NODE_MAPS = {};
NODE_MAP_TYPES.forEach(function(NODE_MAP_TYPE) { NODE_MAPS[NODE_MAP_TYPE] = {}; });
var IGNORED_NODE_TYPE_IDS = {"Hero" : ["Random"]};

tiptoe(
	/*function clearOut()
	{
		base.info("Clearing 'out' directory...");
		rimraf(OUT_PATH, this);
	},
	function createOut()
	{
		fs.mkdir(OUT_PATH, this);
	},
	function copyBuildInfo()
	{
		base.info("Copying latest .build.info file...");
		fileUtil.copy(path.join(HOTS_PATH, ".build.info"), path.join(HOTS_DATA_PATH, ".build.info"), this);
	},
	function extractFiles()
	{
		base.info("Extracting needed files...");
		NEEDED_FILE_PATHS.parallelForEach(function(NEEDED_FILE_PATH, subcb)
		{
			runUtil.run(CASCEXTRATOR_PATH, [HOTS_DATA_PATH, "-o", OUT_PATH, "-f", NEEDED_FILE_PATH], {silent:true}, subcb);
		}, this, 10);
	},*/
	function loadDataAndSaveJSON()
	{
		var xmlDocs = [];

		base.info("Loading data...");
		NEEDED_FILE_PATHS.forEach(function(NEEDED_FILE_PATH)
		{
			var diskPath = path.join(OUT_PATH, NEEDED_FILE_PATH.replaceAll("\\\\", "/"));
			if(!fs.existsSync(diskPath))
			{
				base.info("Missing file: %s", NEEDED_FILE_PATH);
				return;
			}
			var fileData = fs.readFileSync(diskPath, {encoding:"utf8"});
			if(diskPath.endsWith("GameStrings.txt"))
			{
				fileData.split("\n").forEach(function(line) {
					S[line.substring(0, line.indexOf("="))] = line.substring(line.indexOf("=")+1).trim();
				});
			}
			else if(diskPath.endsWith(".xml"))
			{
				xmlDocs.push(libxmljs.parseXml(fileData));
			}
		});

		loadMergedNodeMap(xmlDocs);

		var heroes = Object.values(NODE_MAPS["Hero"]).map(function(heroNode) { return processHeroNode(heroNode); });

		base.info("Validating %d heroes...", heroes.length);
		heroes.forEach(validateHero);
		
		base.info("Saving JSON...");

		fs.writeFile(HEROES_OUT_PATH, JSON.stringify(heroes), {encoding:"utf8"}, this);
	},
	function finish(err)
	{
		if(err)
		{
			base.error(err);
			process.exit(1);
		}

		base.info("Done.");

		process.exit(0);
	}
);

function loadMergedNodeMap(xmlDocs)
{
	xmlDocs.forEach(function(xmlDoc)
	{
		xmlDoc.find("/Catalog/*").forEach(function(node)
		{
			if(!node.attr("id") || node.childNodes().length===0)
				return;

			var nodeType = NODE_MAP_TYPES.filter(function(NODE_MAP_TYPE) { return node.name().startsWith("C" + NODE_MAP_TYPE); });
			if(!nodeType || nodeType.length!==1)
				return;

			nodeType = nodeType[0];

			var nodeid = attributeValue(node, "id");
			if(IGNORED_NODE_TYPE_IDS.hasOwnProperty(nodeType) && IGNORED_NODE_TYPE_IDS[nodeType].contains(nodeid))
				return;

			if(!NODE_MAPS[nodeType].hasOwnProperty(nodeid))
			{
				NODE_MAPS[nodeType][nodeid] = node;
				return;
			}

			mergeXML(node, NODE_MAPS[nodeType][nodeid]);
		});
	});
}

function mergeXML(fromNode, toNode)
{
	fromNode.childNodes().forEach(function(childNode)
	{
		if(childNode.name()==="TalentTreeArray")
		{
			var existingChildNode = toNode.get("TalentTreeArray[@Tier='" + attributeValue(childNode, "Tier") + "' and @Column='" + attributeValue(childNode, "Column") + "']");
			if(existingChildNode)
				existingChildNode.remove();
		}

		toNode.addChild(childNode);
	});
}

function processHeroNode(heroNode)
{
	var hero = {};

	// Core hero data
	hero.id = heroNode.attr("id").value();
	hero.name = S["Unit/Name/" + getValue(heroNode, "Unit", "Hero" + hero.id)];
	hero.title =  S["Hero/Title/" + hero.id];

	hero.role = getValue(heroNode, "Role");
	if(hero.role==="Damage")
		hero.role = "Assassin";
	if(!hero.role && !!getValue(heroNode, "Melee"))
		hero.role = "Warrior";

	hero.type = !!getValue(heroNode, "Melee") ? "Melee" : "Ranged";
	hero.gender = getValue(heroNode, "Gender", "Male");
	hero.franchise = getValue(heroNode, "Universe", "Starcraft");
	hero.difficulty = getValue(heroNode, "Difficulty", "Easy");
	if(hero.difficulty==="VeryHard")
		hero.difficulty = "Very Hard";

	var ratingsNode = heroNode.get("Ratings");
	if(ratingsNode)
	{
		hero.ratings =
		{
			damage        : +getValue(ratingsNode, "Damage", attributeValue(ratingsNode, "Damage", 1)),
			utility       : +getValue(ratingsNode, "Utility", attributeValue(ratingsNode, "Utility", 1)),
			survivability : +getValue(ratingsNode, "Survivability", attributeValue(ratingsNode, "Survivability", 1)),
			complexity    : +getValue(ratingsNode, "Complexity", attributeValue(ratingsNode, "Complexity", 1)),
		};
	}

	var releaseDateNode = heroNode.get("ReleaseDate");
	if(releaseDateNode)
		hero.releaseDate = moment(attributeValue(releaseDateNode, "Month", 1) + "-" + attributeValue(releaseDateNode, "Day", 1) + "-" + attributeValue(releaseDateNode, "Year", "2014"), "M-D-YYYY").format("YYYY-MM-DD");

	// Talents
	hero.talents = {};
	C.HERO_TALENT_LEVELS.forEach(function(HERO_TALENT_LEVEL) { hero.talents[HERO_TALENT_LEVEL] = []; });
	heroNode.find("TalentTreeArray").forEach(function(talentTreeNode)
	{
		var talent = {};

		if(!!attributeValue(talentTreeNode, "removed"))
			return;

		talent.id = attributeValue(talentTreeNode, "Talent");

		var talentNode = NODE_MAPS["Talent"][talent.id];
		var faceid = getValue(talentNode, "Face");

		talent.description = S["Button/Tooltip/" + faceid];

		if(!talent.description && faceid==="TyrandeHuntersMarkTrueshotAuraTalent")
			talent.description = S["Button/Tooltip/TyrandeTrueshotBowTalent"];

		if(!talent.description)
		{
			base.warn("Missing talent description for hero [%s] and talentid [%s] and faceid [%s]", hero.id, talent.id, faceid);
			return;
		}

		talent.name = talent.description.replace(/<s val="StandardTooltipHeader">([^<]+)<.+/, "$1").trim();
		talent.description = talent.description.replace(/<s val="StandardTooltipHeader">[^<]+(<.+)/, "$1").replace(/<s val="StandardTooltip">?(.+)/, "$1");
		//if(talent.description.indexOf("<n/>")===0)
		//	talent.description = talent.description.replace(/(?:<n\/>)+(.+)/, "$1");

		//talent.name = S["Button/Name/" + faceid];

		if(hero.id==="Nova")
		{
			var dynamics = talent.description.match(/<d [^/]+\/>/g);
			if(dynamics)
			{
				dynamics.forEach(function(dynamic)
				{
					var formula = dynamic.match(/ref\s*=\s*"([^"]+)"/, "$1")[1];
					var precision = dynamic.match(/precision\s*=\s*"([^"]+)"/, "$1") ? +dynamic.match(/precision\s*=\s*"([^"]+)"/, "$1")[1] : 0;

					//base.info("(%s) PARSING: %s (precision=%s)", talent.name, formula, precision);
					var result = FORMULA_PARSER.parse(formula, {lookupXMLRef : lookupXMLRef});

					talent.description = talent.description.replace(dynamic, result);
					//talent.description = talent.description.replace(/<s val="StandardTooltipDetails">([^<]+)<\/s>/, "$1");
				});

				talent.description = talent.description.replace(/<\/?n\/?><\/?n\/?>/g, "\n").replace(/<\/?n\/?>/g, "");
				talent.description = talent.description.replace(/<s\s*val\s*=\s*"StandardTooltipDetails">/gm, "").replace(/<s\s*val\s*=\s*"StandardTooltip">/gm, "").replace(/<\/?s\/?>/g, "").trim();
				base.info("%s\n", talent.description);
			}
		}

		hero.talents[C.HERO_TALENT_LEVELS[((+attributeValue(talentTreeNode, "Tier"))-1)]].push(talent);
	});
	
	// Final modifications
    performHeroModifications(hero);
	
	return hero;
}

function lookupXMLRef(query)
{
	var result = 0;

	//base.info("QUERY: %s", query);

	var parts = query.split(",");
	if(!NODE_MAP_TYPES.contains(parts[0]))
	{
		base.warn("No valid node map type for XML query: %s", query);
		return result;
	}

	var nodeMap = NODE_MAPS[parts[0]];
	if(!nodeMap.hasOwnProperty(parts[1]))
	{
		base.warn("No valid id for nodeMapType XML parts: %s", parts);
		return result;
	}

	base.info("%s => %d", query, result);

	return result;
	//Behavior,NovaOneintheChamber,Modification.DamageDealtFraction[Ranged]

	//100*Behavior,NovaOneintheChamber,Modification.DamageDealtFraction[Ranged]
	/*<CBehaviorBuff id="NovaOneintheChamber">
        <Alignment value="Positive"/>
        <Modification>
            <DamageDealtFraction index="Ranged" value="0.8"/>
        </Modification>
        <DamageResponse Chance="1" Handled="NovaOneintheChamberRemoveBehavior" Location="Attacker">
            <Kind index="Spell" value="0"/>
            <Kind index="Melee" value="0"/>
            <Kind index="NoProc" value="0"/>
        </DamageResponse>
        <InfoIcon value="Assets\Textures\storm_btn-extra_int_0.dds"/>
        <Duration value="3"/>
    </CBehaviorBuff>

 */
}

function performHeroModifications(hero)
{
	if(!C.HERO_MODIFICATIONS.hasOwnProperty(hero.id))
		return;

	C.HERO_MODIFICATIONS[hero.id].forEach(function(HERO_MODIFICATION)
	{
		var match = jsonselect.match(HERO_MODIFICATION.path, hero);
		if(!match || match.length<1)
		{
			base.error("Failed to match [%s] to: %s", HERO_MODIFICATION.path, hero);
			return;
		}

		match[0][HERO_MODIFICATION.name] = HERO_MODIFICATION.value;
	});
}

function validateHero(hero)
{
	var validator = jsen(C.HERO_JSON_SCHEMA);
	if(!validator(hero))
	{
		base.warn("Hero %s (%s) has FAILED VALIDATION", hero.id, hero.name);
		base.info(validator.errors);
	}
}

function getValue(node, subnodeName, defaultValue)
{
	var subnode = node.get(subnodeName);
	if(!subnode)
		return defaultValue || undefined;

	return attributeValue(subnode, "value", defaultValue);
}

function attributeValue(node, attrName, defaultValue)
{
	var attr = node.attr(attrName);
	if(!attr)
		return defaultValue || undefined;

	return attr.value();
}