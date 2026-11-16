package patchparam

type Mode int

type ProfilePatch struct {
	Name string
	Mode Mode
	Pin  bool
}

type Profile struct {
	Name string
	Mode Mode
	Pin  bool
}

func (p *Profile) Apply(patch *ProfilePatch) {
	if patch.Name != "" {
		p.Name = patch.Name
	}
	p.Mode = patch.Mode // want unguarded
	p.Pin = patch.Pin   // want unguarded
}
