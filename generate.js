"use strict";

var base = require("@sembiance/xbase"),
	fs = require("fs"),
	path = require("path"),
	runUtil = require("@sembiance/xutil").run,
	fileUtil = require("@sembiance/xutil").file,
	moment = require("moment"),
	jsen = require("jsen"),
	jsonselect = require("JSONSelect"),
	libxmljs = require("libxmljs"),
	C = require("C"),
	rimraf = require("rimraf"),
	tiptoe = require("tiptoe");

var HOTS_PATH = process.argv[2] || "/Applications/Heroes\ of\ the\ Storm";
var HOTS_LANG = process.argv[3] || "enus";

if(!fs.existsSync(HOTS_PATH))
{
	base.error("Usage: node generate.js [/path/to/hots] [language]");
	process.exit(1);
}

var HOTS_DATA_PATH = path.join(HOTS_PATH, "HeroesData");

if(!fs.existsSync(HOTS_DATA_PATH))
{
	base.error("HeroesData dir not found: %s", HOTS_DATA_PATH);
	process.exit(1);
}

var CASCEXTRATOR_PATH = path.join(__dirname, "build", "bin", "CASCExtractor");

var OUT_PATH = path.join(__dirname, "out");

var HEROES_OUT_PATH = path.join(OUT_PATH, "heroes.json");
var MOUNTS_OUT_PATH = path.join(OUT_PATH, "mounts.json");

var DEFAULT_NODES = {};
var NODE_MAPS = {};
var NODE_MAP_TYPES = ["Hero", "Talent", "Behavior", "Effect", "Abil", "Unit", "Validator", "Weapon", "Button", "Mount", "Actor", "Accumulator" ];
var NODE_MAP_PREFIX_TYPES = ["Actor"];

var NODE_MERGE_PARENT_TYPES = ["Mount"];

var HERO_LEVEL_SCALING_MODS = {};

var NEEDED_SUBFIXES = [ HOTS_LANG + ".stormdata\\LocalizedData\\GameStrings.txt" ];
NODE_MAP_TYPES.forEach(function(NODE_MAP_TYPE)
{
	NODE_MAPS[NODE_MAP_TYPE] = {};
	NEEDED_SUBFIXES.push("base.stormdata\\GameData\\" + NODE_MAP_TYPE.toProperCase() + "Data.xml");
});

var NEEDED_PREFIXES = ["heroesdata.stormmod"];
C.EXTRA_HEROES_HEROMODS.forEach(function(EXTRA_HERO)
{
	NEEDED_PREFIXES.push("heromods\\" + EXTRA_HERO + ".stormmod");
});

var NEEDED_FILE_PATHS = [
  "mods/core.stormmod/base.stormdata/DataBuildId.txt"
];

NEEDED_PREFIXES.forEach(function(NEEDED_PREFIX)
{
	NEEDED_SUBFIXES.forEach(function(NEEDED_SUBFIX)
	{
		NEEDED_FILE_PATHS.push("mods\\" + NEEDED_PREFIX + "\\" + NEEDED_SUBFIX);
	});
});

C.EXTRA_HEROES_GAMEDATA_FILES.forEach(function(EXTRA_HERO)
{
	NEEDED_FILE_PATHS.push("mods\\heroesdata.stormmod\\base.stormdata\\GameData\\Heroes\\" + EXTRA_HERO + "Data.xml");
});

C.EXTRA_HEROES_GAMEDATA_FOLDERS.forEach(function(EXTRA_HERO)
{
	NEEDED_FILE_PATHS.push("mods\\heroesdata.stormmod\\base.stormdata\\GameData\\Heroes\\" + EXTRA_HERO + "Data\\" + EXTRA_HERO + "Data.xml");
});

Object.forEach(C.EXTRA_MOUNT_DATA_FILES, function(EXTRA_MOUNT_DIR, EXTRA_MOUNT_FILES)
{
	EXTRA_MOUNT_FILES.forEach(function(EXTRA_MOUNT_FILE)
	{
		NEEDED_FILE_PATHS.push("mods\\heroesdata.stormmod\\base.stormdata\\GameData\\Mounts\\" + EXTRA_MOUNT_DIR + "Data\\Mount_" + EXTRA_MOUNT_FILE + "Data.xml");
	});
});

Object.forEach(C.EXTRA_HEROES_HEROMODS_NAMED, function(heroName, gameDataName)
{
	NEEDED_FILE_PATHS.push("mods\\heromods\\" + heroName + ".stormmod\\base.stormdata\\GameData\\" + gameDataName + "Data.xml");
	NEEDED_FILE_PATHS.push("mods\\heromods\\" + heroName + ".stormmod\\base.stormdata\\GameData\\HeroData.xml");
	NEEDED_FILE_PATHS.push("mods\\heromods\\" + heroName + ".stormmod\\"+HOTS_LANG+".stormdata\\LocalizedData\\GameStrings.txt");
});

NEEDED_FILE_PATHS = NEEDED_FILE_PATHS.concat(C.EXTRA_XML_FILE_PATHS);

var S = {};
var IGNORED_NODE_TYPE_IDS = {"Hero" : ["Random", "AI", "_Empty", "LegacyVOHero", "TestHero"]};

tiptoe(
	function clearOut()
	{
		if(process.argv[4]==="dev")
			return this();

		base.info("Clearing 'out' directory...");
		rimraf(OUT_PATH, this);
	},
	function createOut()
	{
		if(process.argv[4]==="dev")
			return this();

		fs.mkdir(OUT_PATH, this);
	},
	function copyBuildInfo()
	{
		if(process.argv[3]==="dev")
			return this();

		base.info("Copying latest .build.info file...");
		fileUtil.copy(path.join(HOTS_PATH, ".build.info"), path.join(HOTS_DATA_PATH, ".build.info"), this);
	},
	function extractFiles()
	{
		if(process.argv[4]==="dev")
			return this();

		base.info("Extracting %d needed files...", NEEDED_FILE_PATHS.length);
		NEEDED_FILE_PATHS.parallelForEach(function(NEEDED_FILE_PATH, subcb)
		{
			runUtil.run(CASCEXTRATOR_PATH, [HOTS_DATA_PATH, "-o", OUT_PATH, "-f", NEEDED_FILE_PATH], {silent: true}, subcb);
		}, this, 10);
	},
	function loadDataAndSaveJSON()
	{
		var xmlDocs = [];

		base.info("Loading data...");
		NEEDED_FILE_PATHS.forEach(function(NEEDED_FILE_PATH)
		{
			var diskPath = path.join(OUT_PATH, NEEDED_FILE_PATH.replaceAll("\\\\", "/"));
			if(!fs.existsSync(diskPath))
			{
				//base.info("Missing file: %s", NEEDED_FILE_PATH);
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

		mergeNodeParents();

		base.info("\nProcessing heroes...");
		var heroes = Object.values(NODE_MAPS["Hero"]).map(function(heroNode) { return processHeroNode(heroNode); }).filterEmpty();
		heroes.sort(function(a, b) { return (a.name.startsWith("The ") ? a.name.substring(4) : a.name).localeCompare((b.name.startsWith("The ") ? b.name.substring(4) : b.name)); });

		base.info("\nValidating %d heroes...", heroes.length);
		heroes.forEach(validateHero);

		base.info("\nProcessing mounts...");
		var mounts = Object.values(NODE_MAPS["Mount"]).map(function(mountNode) { return processMountNode(mountNode); }).filterEmpty();

		base.info("\nValidating %d mounts...", mounts.length);
		mounts.forEach(validateMount);
		mounts.sort(function(a, b) { return (a.name.startsWith("The ") ? a.name.substring(4) : a.name).localeCompare((b.name.startsWith("The ") ? b.name.substring(4) : b.name)); });

		base.info("\nSaving JSON...");

		fs.writeFile(HEROES_OUT_PATH, JSON.stringify(heroes), {encoding:"utf8"}, this.parallel());
		fs.writeFile(MOUNTS_OUT_PATH, JSON.stringify(mounts), {encoding:"utf8"}, this.parallel());
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

function processMountNode(mountNode)
{
	var mount = {};
	mount.id = attributeValue(mountNode, "id");
	mount.attributeid = getValue(mountNode, "AttributeId");
	mount.name = S["Mount/Name/" + mount.id];

	if(!mount.name) {
		return undefined;
	}

	mount.variation = (+getValue(mountNode, "Flags[@index='IsVariation']", 0) === 1) ? true : false;

	mount.description = S["Mount/Info/" + mount.id];
	// Some mounts share info with their model parent
	if(!mount.description && S["Mount/Info/" + getValue(mountNode, "Model")]) {
		mount.description = S["Mount/Info/" + getValue(mountNode, "Model")];
	}

	mount.franchise = getValue(mountNode, "Universe");
	mount.releaseDate = processReleaseDate(mountNode.get("ReleaseDate"));
	mount.productid = getValue(mountNode, "ProductId");
	mount.category = getValue(mountNode, "MountCategory");
	if(mount.productid)
		mount.productid = +mount.productid;

    performMountModifications(mount);

	return mount;
}

function processHeroNode(heroNode)
{
	base.info(heroNode);
	var hero = {};

	// Core hero data
	hero.id = attributeValue(heroNode, "id");

	if(C.SKIP_HERO_IDS.contains(hero.id))
		return;
	
	hero.attributeid = getValue(heroNode, "AttributeId");
	hero.name = S["Unit/Name/" + getValue(heroNode, "Unit", "Hero" + hero.id)] || S[getValue(heroNode, "Name")];
	
	if(!hero.name)
	{
		base.info(heroNode.toString());
		throw new Error("Failed to get name for hero: " + hero.id);
	}

	base.info("Processing hero: %s (%s)", hero.name, hero.id);
	hero.title =  S["Hero/Title/" + hero.id];
	hero.description = S["Hero/Description/" + hero.id];

	hero.icon = "ui_targetportrait_hero_" + (C.HERO_ID_TEXTURE_RENAMES.hasOwnProperty(hero.id) ? C.HERO_ID_TEXTURE_RENAMES[hero.id] : hero.id) + ".dds";

	hero.role = getValue(heroNode, "Role");
	if(hero.role==="Damage")
		hero.role = "Assassin";
	if(!hero.role)
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

	hero.releaseDate = processReleaseDate(heroNode.get("ReleaseDate"));

	var heroUnitids = [ hero.id ];
	var alternateUnitArrayNodes = heroNode.find("AlternateUnitArray");
	if(alternateUnitArrayNodes && alternateUnitArrayNodes.length>0)
	{
		alternateUnitArrayNodes.forEach(function(alternateUnitArrayNode)
		{
			var alternateHeroid = attributeValue(alternateUnitArrayNode, "value");
      base.info("Alternate: ", alternateHeroid);
			heroUnitids.push(alternateHeroid);
		});
	}

	heroUnitids = heroUnitids.concat(C.ADDITIONAL_HERO_SUBUNIT_IDS[hero.id] || []);
  base.info("Sub-units:", hero.id, heroUnitids);

	// Level Scaling Info
	HERO_LEVEL_SCALING_MODS[hero.id] = [];
	addHeroLevelScalingMods(hero.id, DEFAULT_NODES["Hero"]);
	addHeroLevelScalingMods(hero.id, heroNode);

	// Hero Stats
	hero.stats = {};
	heroUnitids.forEach(function(heroUnitid)
	{
		hero.stats[heroUnitid] = getHeroStats(heroUnitid);
		if(Object.keys(hero.stats[heroUnitid]).length===0)
			delete hero.stats[heroUnitid];
	});

	// Abilities
	hero.abilities = getHeroAbilities(hero.id, hero.name, heroUnitids);

	// Talents
	hero.talents = {};
	C.HERO_TALENT_LEVELS.forEach(function(HERO_TALENT_LEVEL) { hero.talents[HERO_TALENT_LEVEL] = []; });
	var talentTreeNodes = heroNode.find("TalentTreeArray").filter(function(talentTreeNode) { return !!!attributeValue(talentTreeNode, "removed"); });
	talentTreeNodes.sort(function(a, b) { return (+((+attributeValue(a, "Tier"))*10)+(+attributeValue(a, "Column")))-(+((+attributeValue(b, "Tier"))*10)+(+attributeValue(b, "Column"))); });

	talentTreeNodes.forEach(function(talentTreeNode)
	{
		var talent = {};

		talent.id = attributeValue(talentTreeNode, "Talent");

		var talentNode = NODE_MAPS["Talent"][talent.id];
		var faceid = getValue(talentNode, "Face");

		var talentDescription = S["Button/Tooltip/" + faceid];

		if(!talentDescription && faceid==="TyrandeHuntersMarkTrueshotAuraTalent")
			talentDescription = S["Button/Tooltip/TyrandeTrueshotBowTalent"];

		if(!talentDescription)
		{
			base.warn("Missing talent description for hero [%s] and talentid [%s] and faceid [%s]", hero.id, talent.id, faceid);
			return;
		}

		if(talentDescription.contains("StandardTooltipHeader"))
			talent.name = talentDescription.replace(/<s val="StandardTooltipHeader">([^<]+)<.+/, "$1").replace(/<s\s*val\s*=\s*"StandardTooltip">/gm, "").trim();
		else
			talent.name = S[getValue(NODE_MAPS["Button"][faceid], "Name")];

		if(!talent.name)
			talent.name = S["Button/Name/" + faceid];

		//if(hero.id==="L90ETC") { base.info("Talent: %s\n", talent.id); }
		talent.description = getFullDescription(talent.id, talentDescription, hero.id, 0);
		talent.icon = getValue(NODE_MAPS["Button"][faceid], "Icon");
		if(!talent.icon)
			talent.icon = getValue(NODE_MAPS["Button"][attributeValue(NODE_MAPS["Button"][faceid], "parent")], "Icon");

		if(!talent.icon)
			delete talent.icon;
		else
			talent.icon = talent.icon.replace(/Assets\\Textures\\/, "");

		addCooldownInfo(talent, "description");

		if(!talent.cooldown)
			talent.cooldown = getAbilityCooldown(NODE_MAPS["Abil"][getValue(talentNode, "Abil")]);

		var talentPrerequisiteNode = talentTreeNode.get("PrerequisiteTalentArray");
		if(talentPrerequisiteNode)
			talent.prerequisite = attributeValue(talentPrerequisiteNode, "value");

		hero.talents[C.HERO_TALENT_LEVELS[((+attributeValue(talentTreeNode, "Tier"))-1)]].push(talent);
	});
	
	// Final modifications
    performHeroModifications(hero);

	return hero;
}

function addHeroLevelScalingMods(heroid, heroNode)
{
//	console.log('==============',heroNode.toString());
	heroNode.find("LevelScalingArray/Modifications").forEach(function(modNode)
	{
		var modType = getValue(modNode, "Catalog", attributeValue(modNode, "Catalog")) || 'Undefined';
/*		if(!NODE_MAP_TYPES.contains(modType))
			throw new Error("Unsupported LevelScalingArray Modification Catalog modType: " + modType);*/

		var modKey = getValue(modNode, "Entry", attributeValue(modNode, "Entry"));
		if(!modKey)
			throw new Error("No Entry node in LevelScalingArray Modification (" + modKey + ") for hero: " + heroid);

		var modTarget = getValue(modNode, "Field", attributeValue(modNode, "Field"));
		if(!modTarget)
			throw new Error("No Field node in LevelScalingArray Modification (" + modTarget + ") for hero: " + heroid);

		var modValue = getValue(modNode, "Value", attributeValue(modNode, "Value"));
		if(!modValue)
			return;

		HERO_LEVEL_SCALING_MODS[heroid].push({type:modType,key:modKey,target:modTarget,value:(+modValue)});
	});
}

function getHeroAbilities(heroid, heroName, heroUnitids)
{
	var abilities = {};

	var heroHeroicAbilityids = [];
	var heroTraitAbilityids = [];
	var heroAbilityids = [];
	var heroNode = NODE_MAPS["Hero"][heroid];
	heroNode.find("HeroAbilArray").forEach(function(heroAbilNode)
	{
		if(!heroAbilNode.get("Flags[@index='ShowInHeroSelect' and @value='1']"))
			return;

		var abilityIsTrait = !!heroAbilNode.get("Flags[@index='Trait' and @value='1']");

		var abilid = attributeValue(heroAbilNode, "Abil");
		if(!abilid)
		{
			var buttonid = attributeValue(heroAbilNode, "Button");
			if(!buttonid)
				throw new Error("No abil or button for: " + heroAbilNode.toString());

			var descriptionIdsToTry = [];
			var buttonidShort = ["HeroSelect", "HeroSelectButton"].mutateOnce(function(buttonSuffix) { if(buttonid.endsWith(buttonSuffix)) { return buttonid.substring(0, buttonid.length-buttonSuffix.length); } });
			if(!buttonidShort)
				buttonidShort = buttonid;
			descriptionIdsToTry.push(buttonidShort);
			descriptionIdsToTry.push(heroid + buttonidShort);
			if(abilityIsTrait)
			{
				descriptionIdsToTry.push(buttonidShort + "Trait");
				if(buttonidShort.contains(heroid))
					descriptionIdsToTry.push(buttonidShort.replace(heroid, heroid + "Trait"));
			}
			descriptionIdsToTry.push(buttonidShort + "Talent");

			abilid = descriptionIdsToTry.mutateOnce(function(descriptionIdToTry) { if(S["Button/Tooltip/" + descriptionIdToTry]) { return descriptionIdToTry; }});
		}

		if(abilityIsTrait)
			heroTraitAbilityids.push(abilid);

		if(heroAbilNode.get("Flags[@index='Heroic' and @value='1']"))
			heroHeroicAbilityids.push(abilid);

		heroAbilityids.push(abilid);
	});

	abilities[heroid] = getUnitAbilities(heroid, heroName, heroAbilityids.concat((C.VALID_UNIT_ABILITY_IDS[heroid] || [])).subtract((C.HERO_SKIP_ABILITY_IDS[heroid] || [])), heroHeroicAbilityids, heroTraitAbilityids, "Hero" + (C.HERO_UNIT_ID_REPLACEMENTS[heroid] || heroid));

	heroUnitids.forEach(function(heroUnitid)
	{
		if(heroUnitid===heroid)
			return;

		abilities[heroUnitid] = getUnitAbilities(heroid, heroName, heroAbilityids.concat((C.VALID_UNIT_ABILITY_IDS[heroUnitid] || [])).subtract((C.HERO_SKIP_ABILITY_IDS[heroUnitid] || [])), heroHeroicAbilityids, heroTraitAbilityids, heroUnitid);
	});

	heroUnitids.concat([heroid]).forEach(function(heroUnitid)
	{
		Object.forEach(C.IMPORT_ABILITIES_FROM_SUBUNIT, function(importToid, importFromid)
		{
			if(importToid!==heroUnitid)
				return;

			abilities[importToid] = abilities[importFromid];
		});
	});

	(C.REMOVE_SUBUNITS[heroid] || []).forEach(function(REMOVE_SUBUNIT)
	{
		delete abilities[REMOVE_SUBUNIT];
	});

	if(C.MOUNT_ABILITY_IDS.hasOwnProperty(heroid))
	{
		var mountAbility = getUnitAbilities(heroid, heroName, [C.MOUNT_ABILITY_IDS[heroid]], [], [], "Hero" + (C.HERO_MOUNT_UNIT_ID_REPLACEMENTS[heroid] || heroid))[0] || {};
		mountAbility.shortcut = "Z";
		mountAbility.mount = true;
		abilities[heroid].push(mountAbility);
	}

	return abilities;
}

function getUnitAbilities(heroid, heroName, heroAbilityids, heroHeroicAbilityids, heroTraitAbilityids, unitid)
{
	var SHORTCUT_KEY_ORDER = ["Q", "W", "E", "R", "D", "1", "2", "3", "4", "5"];
	var abilities = [];

	var unitNode = NODE_MAPS["Unit"][unitid];
	if(!unitNode)
		return abilities;

	var attributeButtons = unitNode.find("CardLayouts[@index='0']/LayoutButtons");
	if(attributeButtons.length===0)
		attributeButtons = unitNode.find("CardLayouts/LayoutButtons");
	if(attributeButtons.length===0)
		attributeButtons = [];

	attributeButtons.forEach(function(layoutButtonNode)
	{
		var buttonRow = attributeValue(layoutButtonNode, "Row", getValue(layoutButtonNode, "Row", null));
		var buttonColumn = attributeValue(layoutButtonNode, "Column", getValue(layoutButtonNode, "Column", null));

		if(buttonRow===null || buttonColumn===null)
			return;

		buttonRow = +buttonRow;
		buttonColumn = +buttonColumn;

		var ability = {};
		ability.id = attributeValue(layoutButtonNode, "Face", getValue(layoutButtonNode, "Face"));

		var abilityCmdid = attributeValue(layoutButtonNode, "AbilCmd", getValue(layoutButtonNode, "AbilCmd"));
		if(abilityCmdid)
			abilityCmdid = abilityCmdid.split(",")[0];

		if(!heroAbilityids.contains(ability.id) && !heroAbilityids.contains(abilityCmdid))
			return;

		var abilNode = NODE_MAPS["Abil"][ability.id];
		if(!abilNode && abilityCmdid)
			abilNode = NODE_MAPS["Abil"][abilityCmdid];

		if(heroTraitAbilityids.contains(ability.id) || heroTraitAbilityids.contains(abilityCmdid))
			ability.trait = true;

		if(!ability.trait && !abilNode)
			throw new Error("Failed to find ability node: " + layoutButtonNode.toString());
		
		if(abilNode)
		{
			var cmdButtonNode = abilNode.get("CmdButtonArray[@index='Execute']");
			if(cmdButtonNode)
				ability.icon = getValue(NODE_MAPS["Button"][attributeValue(cmdButtonNode, "DefaultButtonFace")], "Icon");

			var energyCostNode = abilNode.get("Cost/Vital[@index='Energy']");
			if(energyCostNode)
				ability.manaCost = +attributeValue(energyCostNode, "value");
		}

		if(!ability.icon)
			ability.icon = getValue(NODE_MAPS["Button"][ability.id], "Icon");

		if(!ability.icon)
			delete ability.icon;
		else
			ability.icon = ability.icon.replace(/Assets\\Textures\\/, "");

		if(heroHeroicAbilityids.contains(ability.id) || heroHeroicAbilityids.contains(abilityCmdid))
			ability.heroic = true;

		addAbilityDetails(ability, heroid, heroName, abilityCmdid);

		if(abilNode && !ability.hasOwnProperty("cooldown"))
		{
			ability.cooldown = getAbilityCooldown(abilNode);
			if(!ability.cooldown)
				delete ability.cooldown;

			ability.description = ability.description.replace("Cooldown: " + ability.cooldown + " seconds\n", "");
		}

		ability.tempSortOrder = (buttonRow*5)+buttonColumn;

		if(!ability.trait)
		{
			ability.shortcut = SHORTCUT_KEY_ORDER[ability.tempSortOrder];
	
			if(!NODE_MAPS["Abil"][ability.id] && NODE_MAPS["Abil"][abilityCmdid])
				ability.id = abilityCmdid;
		}
		else
		{
			if(!heroTraitAbilityids.contains(ability.id) && heroTraitAbilityids.contains(abilityCmdid))
				ability.id = abilityCmdid;
		}

		if(C.ABILITY_SHORTCUT_REMAPS.hasOwnProperty(ability.id))
			ability.shortcut = C.ABILITY_SHORTCUT_REMAPS[ability.id];

		var addAbility = true;
		abilities = abilities.filter(function(existingAbility)
		{
			if(!addAbility || existingAbility.id!==ability.id)
				return true;

			if(!existingAbility.shortcut && ability.shortcut)
				return false;

			addAbility = false;

			return true;
		});

		if(addAbility)
			abilities.push(ability);
	});

	(C.IMPORT_ABILITIES[unitid] || []).forEach(function(abilityToAdd)
	{
		var ability = {};
		ability.id = abilityToAdd.id;
		ability.icon = abilityToAdd.icon;
		console.log(ability);
		addAbilityDetails(ability, heroid, heroName, undefined, abilityToAdd.name);

		if(abilityToAdd.shortcut)
			ability.shortcut = abilityToAdd.shortcut;
		if(abilityToAdd.trait)
			ability.trait = abilityToAdd.trait;

		abilities.push(ability);
	});

	abilities.sort(function(a, b) { return a.tempSortOrder-b.tempSortOrder; });
	abilities.forEach(function(ability)
	{
		delete ability.tempSortOrder;
	});

	return abilities;
}

function getAbilityCooldown(abilNode)
{
	if(!abilNode)
		return;

	var cooldownAttribute = abilNode.get("OffCost/Cooldown[@Location='Unit']/../Charge/TimeUse/@value") || abilNode.get("OffCost/Cooldown[@Location='Unit']/@TimeUse") ||
							abilNode.get("Cost/Cooldown[@Location='Unit']/../Charge/TimeUse/@value") || abilNode.get("Cost/Cooldown[@Location='Unit']/@TimeUse");
	if(!cooldownAttribute)
		return;

	return +cooldownAttribute.value();
}

function addAbilityDetails(ability, heroid, heroName, abilityCmdid, abilityName)
{
	if(C.USE_ABILITY_NAME.contains(heroid))
		ability.name = abilityName || S["Abil/Name/" + ability.id] || S["Abil/Name/" + abilityCmdid];
	else
		ability.name = abilityName || S["Button/Name/" + ability.id] || S["Button/Name/" + abilityCmdid];

	if(!ability.name)
		throw new Error("Failed to get ability name: " + ability.id + " and " + abilityCmdid);

	if(ability.name.startsWith(heroid + " "))
		ability.name = ability.name.substring(heroid.length+1).trim();
	if(ability.name.startsWith(heroName + " "))
		ability.name = ability.name.substring(heroName.length+1).trim();

	var abilityDescription = S["Button/Tooltip/" + ability.id] || S["Button/Tooltip/" + abilityCmdid];
	if(C.ABILITY_ID_DESCRIPTION_IDS[heroid])
		abilityDescription = S["Button/Tooltip/" + C.ABILITY_ID_DESCRIPTION_IDS[heroid][ability.id]] || abilityDescription;
	if(!abilityDescription)
		throw new Error("Failed to get ability description: " + ability.id + " and " + abilityCmdid);
	
	ability.description = getFullDescription(ability.id, abilityDescription, heroid, 0);

	ability.description = ability.description.replace("Heroic Ability\n", "").replace("Heroic Passive\n", "").replace("Trait\n", "");

	addCooldownInfo(ability, "description");

	var manaPerSecondMatch = ability.description.match(/Mana:\s*([0-9]+)\s+per\s+second\n/m);
	if(manaPerSecondMatch)
	{
		ability.manaCostPerSecond = +manaPerSecondMatch[1];
		ability.description = ability.description.replace(manaPerSecondMatch[0], "");
	}

	var aimTypeMatch = ability.description.match(/((?:Skillshot)|(?:Area of Effect)|(?:Cone))\n/);
	if(aimTypeMatch)
	{
		ability.aimType = aimTypeMatch[1];
		ability.description = ability.description.replace(aimTypeMatch[0], "");
	}
}

function addCooldownInfo(o, field)
{
	var cooldownMatch = o[field].match(/(?:Charge )?Cooldown:\s*([0-9]+)\s+[sS]econds?\n/m);
	if(cooldownMatch)
	{
		o.cooldown = +cooldownMatch[1];
		o[field] = o[field].replace(cooldownMatch[0], "");
	}
}

function getHeroStats(heroUnitid)
{
	var heroStats = {};

	var heroUnitNode = NODE_MAPS["Unit"][(!heroUnitid.startsWith("Hero") ? "Hero" : "") + heroUnitid] || NODE_MAPS["Unit"][heroUnitid];
	if(heroUnitNode)
	{
		heroStats.hp = +getValue(heroUnitNode, "LifeMax") || 0;
		heroStats.hpPerLevel = 0;
		heroStats.hpRegen = +getValue(heroUnitNode, "LifeRegenRate") || 0;
		heroStats.hpRegenPerLevel = 0;

		heroStats.mana = +getValue(heroUnitNode, "EnergyMax", 500) || 0;
		heroStats.manaPerLevel = 0;
		heroStats.manaRegen = +getValue(heroUnitNode, "EnergyRegenRate", 3) || 0;
		heroStats.manaRegenPerLevel = 0;

		(heroUnitNode.find("BehaviorArray") || []).forEach(function(behaviorArrayNode)
		{
			var behaviorNode = NODE_MAPS["Behavior"][attributeValue(behaviorArrayNode, "Link")];
			if(!behaviorNode)
				return;

			if(attributeValue(behaviorNode, "parent")!=="HeroXPCurve")
				return;

			var levelOneNode = behaviorNode.get("VeterancyLevelArray[@index='1']/Modification");
			if(!levelOneNode)
				return;

			var hpPerLevelAttribute = levelOneNode.get("VitalMaxArray[@index='Life']/@value");
			if(hpPerLevelAttribute)
				heroStats.hpPerLevel = (heroStats.hpPerLevel || 0) + (+hpPerLevelAttribute.value());

			var hpRegenPerLevelAttribute = levelOneNode.get("VitalRegenArray[@index='Life']/@value");
			if(hpRegenPerLevelAttribute)
				heroStats.hpRegenPerLevel = (heroStats.hpRegenPerLevel || 0) + (+hpRegenPerLevelAttribute.value());

			var manaPerLevelAttribute = levelOneNode.get("VitalMaxArray[@index='Energy']/@value");
			if(manaPerLevelAttribute)
				heroStats.manaPerLevel = (heroStats.manaPerLevel || 0) + (+manaPerLevelAttribute.value());

			var manaRegenPerLevelAttribute = levelOneNode.get("VitalRegenArray[@index='Energy']/@value");
			if(manaRegenPerLevelAttribute)
				heroStats.manaRegenPerLevel = (heroStats.manaRegenPerLevel || 0) + (+manaRegenPerLevelAttribute.value());
		});

		if(HERO_LEVEL_SCALING_MODS.hasOwnProperty(heroUnitid))
		{
			HERO_LEVEL_SCALING_MODS[heroUnitid].forEach(function(scalingMod)
			{
				if(scalingMod.type!=="Unit" || scalingMod.value===0)
					return;

				if(heroStats.hpPerLevel===0 && scalingMod.target==="LifeMax")
					heroStats.hpPerLevel = scalingMod.value*100;

				if(heroStats.hpRegenPerLevel===0 && scalingMod.target==="LifeRegenRate")
					heroStats.hpRegenPerLevel = scalingMod.value*100;
			});
		}
	}

	return heroStats;
}

function getFullDescription(id, _fullDescription, heroid, heroLevel)
{
	var fullDescription = _fullDescription;

	fullDescription = fullDescription.replace(/<s val="StandardTooltipHeader">[^<]+(<.+)/, "$1").replace(/<s val="StandardTooltip">?(.+)/, "$1");
	fullDescription = fullDescription.replace(/<s val="StandardTooltipHeader">/g, "");

	(fullDescription.match(/<d ref="[^"]+"[^/]*\/>/g) || []).forEach(function(dynamic)
	{
		var formula = dynamic.match(/ref\s*=\s*"([^"]+)"/)[1];
		if(formula.endsWith(")") && !formula.contains("("))
			formula = formula.substring(0, formula.length-1);

		try
		{
			C.FORMULA_PRE_REPLACEMENTS.forEach(function(FORMULA_PRE_REPLACEMENT)
			{
                //console.log("Formula: " + formula);
                //console.log("Match: " + FORMULA_PRE_REPLACEMENT.match);
                //console.log("is a match: " + formula.localeCompare(FORMULA_PRE_REPLACEMENT.match).toString());
				if(formula.contains(FORMULA_PRE_REPLACEMENT.match)) {
                    formula = formula.replace(FORMULA_PRE_REPLACEMENT.match, FORMULA_PRE_REPLACEMENT.replace);
                    //console.log("replaced: " + formula);
                }
			});

			formula = formula.replace(/\$BehaviorStackCount:[^$]+\$/g, "0");
			formula = formula.replace(/\[d ref='([^']+)'(?: player='[0-9]')?\/?]/g, "$1");

			//if(heroid==="Tracer") { base.info("Before: %s", formula); }
			formula = formula.replace(/^([ (]*)-/, "$1-1*");

			(formula.match(/((^\-)|(\(\-))?[A-Za-z][A-Za-z0-9,._\[\]]+/g) || []).map(function(match) { return match.indexOf("(")===0 ? match.substring(1) : match; }).forEach(function(match)
			{
				var negative = false;

				if(match.startsWith("-"))
				{
					match = match.substring(1);
					negative = true;
				}
				formula = formula.replace(match, lookupXMLRef(heroid, heroLevel, match, negative));
			});
			//if(heroid==="Tracer") { base.info("after: %s", formula); }

			formula = formula.replace(/[+*/-]$/, "");
			formula = "(".repeat((formula.match(/[)]/g) || []).length-(formula.match(/[(]/g) || []).length) + formula;

      formula = formula.replace(/--/, "+");

			//if(heroid==="Tracer") { base.info("after prenthesiszed and regex: %s", parenthesize(formula)); base.info("after prenthesiszed x2: %s", parenthesize(parenthesize(formula))); }

			//Talent,ArtanisBladeDashSolariteReaper,AbilityModificationArray[0].Modifications[0].Value)*(100)
			
			// Heroes formulas are evaluated Left to Right instead of normal math operation order, so we parenthesize everything. ugh.
			var result = C.FULLY_PARENTHESIZE.contains(id) ? eval(fullyParenthesize(formula)) : eval(parenthesize(formula));	// jshint ignore:line
			
			//if(heroid==="Tracer") { base.info("Formula: %s\nResult: %d", formula, result); }
		
			var MAX_PRECISION = 4;
			if(result.toFixed(MAX_PRECISION).length<(""+result).length)
				result = +result.toFixed(MAX_PRECISION);

			//var precision = dynamic.match(/precision\s*=\s*"([^"]+)"/) ? +dynamic.match(/precision\s*=\s*"([^"]+)"/)[1] : null;
			//if(precision!==null && Math.floor(result)!==result)
			//	result = result.toFixed(precision);

			fullDescription = fullDescription.replace(dynamic, result);
		}
		catch(err)
		{
			base.error("Failed to parse: %s\n(%s)", formula, _fullDescription);
			throw err;
		}
	});

	fullDescription = fullDescription.replace(/<\/?n\/?>/g, "\n");
	fullDescription = fullDescription.replace(/<s\s*val\s*=\s*"StandardTooltipDetails">/gm, "").replace(/<s\s*val\s*=\s*"StandardTooltip">/gm, "").replace(/<\/?[cs]\/?>/g, "");
	fullDescription = fullDescription.replace(/<c\s*val\s*=\s*"[^"]+">/gm, "").replace(/<\/?if\/?>/g, "").trim();
	fullDescription = fullDescription.replace(/ [.] /g, ". ");
	fullDescription = fullDescription.replace(/ [.]([0-9]+)/g, " 0.$1");
	while(fullDescription.indexOf("\n\n")!==-1) { fullDescription = fullDescription.replace(/\n\n/g, "\n"); } 

	if(heroLevel===0)
	{
		var fullDescriptionLevel1 = getFullDescription(id, _fullDescription, heroid, 1);
		if(fullDescription!==fullDescriptionLevel1)
		{
			var beforeWords = fullDescription.split(" ");
			var afterWords = fullDescriptionLevel1.split(" ");
			if(beforeWords.length!==afterWords.length)
				throw new Error("Talent description words length MISMATCH " + beforeWords.length + " vs " + afterWords.length + " for hero (" + heroid + ") and talent: " + fullDescription);

			var updatedWords = [];
			beforeWords.forEach(function(beforeWord, i)
			{
				var afterWord = afterWords[i];
				if(beforeWord===afterWord)
				{
					updatedWords.push(beforeWord);
					return;
				}

				var endWithPeriod = beforeWord.endsWith(".");
				if(endWithPeriod)
				{
					beforeWord = beforeWord.substring(0, beforeWord.length-1);
					afterWord = afterWord.substring(0, afterWord.length-1);
				}

				var isPercentage = beforeWord.endsWith("%");
				if(isPercentage)
				{
					beforeWord = beforeWord.substring(0, beforeWord.length-1);
					afterWord = afterWord.substring(0, afterWord.length-1);
				}

				var valueDifference = (+afterWord).subtract(+beforeWord);

				var resultWord = beforeWord + (isPercentage ? "%" : "") + " (" + (valueDifference>0 ? "+" : "") + valueDifference + (isPercentage ? "%" : "") + " per level)" + (endWithPeriod ? "." : "");

				updatedWords.push(resultWord);
			});

			fullDescription = updatedWords.join(" ");
		}
	}

	return fullDescription;
}

function parenthesize(formula)
{
	var result = [];
	var seenOperator = false;
	var lastOpenParenLoc = 0;
	var seenOneParenClose = true;
	formula.replace(/ /g, "").split("").forEach(function(c, i)
	{
		if("+-/*".contains(c) && seenOperator && seenOneParenClose && !"+-/*(".contains(result.last()))
		{
			result.splice(lastOpenParenLoc, 0, "(");
			result.push(")");
		}

		if(c==="(")
			seenOneParenClose = false;

		if(c===")")
			seenOneParenClose = true;

		if("+-/*".contains(c) && i!==0 && !"+-/*(".contains(result.last()))
			seenOperator = true;

		result.push(c);
	});

	return result.join("");
}

function fullyParenthesize(formula)
{
	var result = [].pushMany("(", formula.replace(/[^+/*-]/g, "").length+1);

	formula.replace(/ /g, "").split("").forEach(function(c, i)
	{
		if(c==="(" || c===")")
			return;

		if("+-/*".contains(c))
			result.push(")");

		result.push(c);
	});

	result.push(")");

	return result.join("");
}

function lookupXMLRef(heroid, heroLevel, query, negative)
{
	var result = 0;

	C.XMLREF_REPLACEMENTS.forEach(function(XMLREF_REPLACEMENT)
	{
		if(query===XMLREF_REPLACEMENT.from)
			query = XMLREF_REPLACEMENT.to;
	});

	//if(heroid==="Tinker") { base.info("QUERY: %s", query); }

	var mainParts = query.split(",");

	if(!NODE_MAP_TYPES.contains(mainParts[0]))
		throw new Error("No valid node map type for XML query: " + query);

	var nodeMap = NODE_MAPS[mainParts[0]];
	if(!nodeMap.hasOwnProperty(mainParts[1]))
	{
		console.log('===================', query);
		base.warn("No valid id for nodeMapType XML parts %s", mainParts);
		return result;
	}

	var target = nodeMap[mainParts[1]];

	if(target.childNodes().length===0)
	{
		if(!C.ALLOWED_EMPTY_XML_REF_IDS.contains(attributeValue(target, "id")))
			base.warn("No child nodes for nodeMapType XML parts [%s] with xml:", mainParts, target.toString());
		return result;
	}

	var subparts = mainParts[2].split(".");

	//if(heroid==="Tinker" && query.contains("TalentBucketPromote")) { base.info("Level %d with mainParts [%s] and subparts [%s] and hero mods:", heroLevel, mainParts.join(", "), subparts.join(", ")); base.info(HERO_LEVEL_SCALING_MODS[heroid]); }

	var additionalAmount = 0;
	HERO_LEVEL_SCALING_MODS[heroid].forEach(function(HERO_LEVEL_SCALING_MOD)
	{
		if(HERO_LEVEL_SCALING_MOD.type!==mainParts[0])
			return;

		if(HERO_LEVEL_SCALING_MOD.key!==mainParts[1])
			return;

		if(HERO_LEVEL_SCALING_MOD.target!==subparts[0] && HERO_LEVEL_SCALING_MOD.target!==subparts[0].replace("[0]", "") &&
		   HERO_LEVEL_SCALING_MOD.target!==subparts.join(".") && HERO_LEVEL_SCALING_MOD.target!==subparts.map(function(subpart) { return subpart.replace("[0]", ""); }).join("."))
			return;

		//if(heroid==="Tinker" && query.contains("TalentBucketPromote")) { base.info("Found additional scaling amount of %d", HERO_LEVEL_SCALING_MOD.value); }
		additionalAmount = heroLevel*HERO_LEVEL_SCALING_MOD.value;
	});

	//if(heroid==="Tinker" && query.contains("TalentBucketPromote") && additionalAmount===0) { base.info("Failed to find an additional amount for: %s", mainParts.join(",")); }

	//if(heroid==="Tinker") { base.info("Start (negative:%s): %s", negative, subparts); }
	subparts.forEach(function(subpart)
	{
		var xpath = !subpart.match(/\[[0-9]+\]/) ? subpart.replace(/([^[]+)\[([^\]]+)]/, "$1[@index = '$2']") : subpart.replace(/\[([0-9]+)\]/, "[" + (+subpart.match(/\[([0-9]+)\]/)[1]+1) + "]");
		//if(heroid==="Tinker") { base.info("Next xpath: %s\nCurrent target: %s\n", xpath, target.toString()); }
		var nextTarget = target.get(xpath);
		if(!nextTarget)
			result = +attributeValue(target, xpath.replace(/([^\[]+).*/, "$1"));
		target = nextTarget;
	});

	if(target)
		result = +attributeValue(target, "value");

	if(isNaN(result))
	{
		if(query.contains("AttributeFactor"))	// These are only set at runtime with talent choices
			result = 0;
		else
			throw new Error("Failed to get XML ref [" + query + "], result is NaN for hero: " + heroid);
	}

	result += additionalAmount;
	//if(heroid==="Tinker") { base.info("%s => %d", query, result); }

	if(negative)
		result = result*-1;

	return result;
}

function performHeroModifications(hero)
{
	if(C.HERO_MODIFICATIONS.hasOwnProperty(hero.id))
	{
		C.HERO_MODIFICATIONS[hero.id].forEach(function(HERO_MODIFICATION)
		{
			var match = jsonselect.match(HERO_MODIFICATION.path, hero);
			if(!match || match.length<1)
			{
				base.error("Failed to match [%s] to: %s", HERO_MODIFICATION.path, hero);
				return;
			}

			(HERO_MODIFICATION.remove || []).forEach(function(keyToRemove) { delete match[0][keyToRemove]; });

			if(HERO_MODIFICATION.name)
				match[0][HERO_MODIFICATION.name] = HERO_MODIFICATION.value;
		});
	}

	if(C.HERO_SUBUNIT_ABILITIES_MOVE.hasOwnProperty(hero.id))
	{
		Object.forEach(C.HERO_SUBUNIT_ABILITIES_MOVE[hero.id], function(srcSubunitid, abilityMoveInfo)
		{
			Object.forEach(abilityMoveInfo, function(abilityId, targetSubunitid)
			{
				var match = null;
				hero.abilities[srcSubunitid] = hero.abilities[srcSubunitid].filter(function(ability) { if(ability.id===abilityId) { match = base.clone(ability); } return ability.id!==abilityId; });
				if(!match)
					base.error("Failed to find hero [%s] with srcSubunitid [%s] and abilityId [%s] and targetSubunitid [%s]", hero.id, srcSubunitid, abilityId, targetSubunitid);
				else
					hero.abilities[targetSubunitid].push(match);
			});
		});
	}
}

function performMountModifications(mount)
{
	if(C.MOUNT_MODIFICATIONS.hasOwnProperty(mount.id))
	{
		C.MOUNT_MODIFICATIONS[mount.id].forEach(function(MOUNT_MODIFICATION)
		{
			var match = jsonselect.match(MOUNT_MODIFICATION.path, mount);
			if(!match || match.length<1)
			{
				base.error("Failed to match [%s] to: %s", MOUNT_MODIFICATION.path, mount);
				return;
			}

			(MOUNT_MODIFICATION.remove || []).forEach(function(keyToRemove) { delete match[0][keyToRemove]; });

			if(MOUNT_MODIFICATION.name)
				match[0][MOUNT_MODIFICATION.name] = MOUNT_MODIFICATION.value;
		});
	}
}

function findParentMount(source, field, value) {
  for (var i = 0; i < source.length; i++) {
    if (source[i][field] === value && source[i].variation === false) {
      return source[i];
    }
  }
  throw "Could not find object where field '" + field + " === " + value + "'" ;
}

function validateMount(mount, index, mounts)
{
	var validator = jsen(C.MOUNT_JSON_SCHEMA);
	if(!validator(mount))
	{
		// For every fail (usually a variation), copy it from the parent)
		validator.errors.forEach(function(elem) {
			var parent = findParentMount(mounts, "productid", mount.productid);
			for (var item in parent) {
				if (mount[item] === undefined) {
					mount[item] = parent[item];
				}
			};
		});
    // WARNING: I may have a race condition here...
		// Revalidate
		if (!validator(mount)) {
			base.warn("Mount %s (%s) has FAILED VALIDATION", mount.id, mount.name);
			base.info(validator.errors);
		}
	}
}

function validateHero(hero)
{
	var validator = jsen(C.HERO_JSON_SCHEMA);
	if(!validator(hero))
	{
		base.warn("Hero %s (%s) has FAILED VALIDATION", hero.id, hero.name);
		base.info(validator.errors);
	}

	Object.forEach(hero.abilities, function(unitName, abilities)
	{
		if(abilities.length!==abilities.map(function(ability) { return ability.name; }).unique().length)
			base.warn("Hero %s has multiple abilities with the same name!", hero.name);
	});
}

function loadMergedNodeMap(xmlDocs)
{
	xmlDocs.forEach(function(xmlDoc)
	{
		xmlDoc.find("/Catalog/*").forEach(function(node)
		{
			var nodeType = NODE_MAP_TYPES.filter(function(NODE_MAP_TYPE) { return node.name()===("C" + NODE_MAP_TYPE); }).concat(NODE_MAP_PREFIX_TYPES.filter(function(NODE_MAP_PREFIX_TYPE) { return node.name().startsWith(NODE_MAP_PREFIX_TYPES); })).unique();
			if(!nodeType || nodeType.length!==1)
				return;

			nodeType = nodeType[0];

			if(node.attr("id") || attributeValue(node, "default")!=="1")
				return;

			if(DEFAULT_NODES.hasOwnProperty(nodeType))
			{
				base.info(DEFAULT_NODES[nodeType].toString());
				base.info(node.toString());
				base.error("MORE THAN ONE DEFAULT! NOT GOOD!");
				process.exit(1);
			}

			DEFAULT_NODES[nodeType] = node;
		});
	});

	xmlDocs.forEach(function(xmlDoc)
	{
		xmlDoc.find("/Catalog/*").forEach(function(node)
		{
			if(!node.attr("id"))
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

function mergeNodeParents()
{
	NODE_MERGE_PARENT_TYPES.forEach(function(NODE_MERGE_PARENT_TYPE)
	{
		Object.forEach(NODE_MAPS[NODE_MERGE_PARENT_TYPE], function(nodeid, node)
		{
			var parentid = attributeValue(node, "parent");
			if(parentid && NODE_MAPS[NODE_MERGE_PARENT_TYPE].hasOwnProperty(parentid))
				mergeXML(NODE_MAPS[NODE_MERGE_PARENT_TYPE][parentid], node, true);
		});
	});
}

function processReleaseDate(releaseDateNode)
{
	return moment(attributeValue(releaseDateNode, "Month", 1) + "-" + attributeValue(releaseDateNode, "Day", 1) + "-" + attributeValue(releaseDateNode, "Year", "2014"), "M-D-YYYY").format("YYYY-MM-DD");
}

function mergeXML(fromNode, toNode, dontAddIfPresent)
{
	fromNode.childNodes().forEach(function(childNode)
	{
		if(childNode.name()==="TalentTreeArray")
		{
			var existingChildNode = toNode.get("TalentTreeArray[@Tier='" + attributeValue(childNode, "Tier") + "' and @Column='" + attributeValue(childNode, "Column") + "']");
			if(existingChildNode)
				existingChildNode.remove();
		}

		if(!toNode.childNodes().map(function(a) { return a.name(); }).contains(childNode.name()) || !dontAddIfPresent)
			toNode.addChild(childNode.clone());
	});
}

function getValue(node, subnodeName, defaultValue)
{
	if(!node)
		return defaultValue || undefined;

	var subnode = node.get(subnodeName);
	if(!subnode)
		return defaultValue || undefined;

	return attributeValue(subnode, "value", defaultValue);
}

function attributeValue(node, attrName, defaultValue)
{
	if(!node)
		return defaultValue || undefined;

	var attr = node.attr(attrName);
	if(!attr)
		return defaultValue || undefined;

	return attr.value();
}
